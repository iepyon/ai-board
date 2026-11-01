import { isDeepStrictEqual } from 'node:util';
import { err, isErr, type Result } from '../../shared/result.js';
import { CardIdSchema, type CardId } from '../../shared/schemas/common.js';
import type { CommitMessage, DataStore, DataStoreError } from '../../infrastructure/data-store.js';
import type { CardDependencies } from '../composition.js';
import type { Card } from '../models/card.js';
import type { CreateCardError, UpdateCardError } from '../errors/card-errors.js';
import { readCardFiles, serializeCard } from '../repositories/card-markdown.js';
import { CardWriteRefusedError } from '../repositories/file-card.repository.js';
import { isReviewGate, type ReviewGate } from '../models/review.js';
import { gateStates, parseReviewLog } from '../services/review-log.js';
import { describeDataStoreError, describeOfflineRead } from './data-store-messages.js';

// ============================================================
// ai-board card — エージェントがカードに書くための CLI
// ============================================================

/**
 * エージェントに許す操作だけを並べる。
 *
 * `startedAt`・`rank`・`skipGates` の書き換えと、承認 / 否決 / 中止の追記は
 * 人の判断であり、ここには入口を置かない（UI と HTTP API からだけ行える）。
 * 本文の差し替えも、`## レビュー` のエントリを変えるものは拒否する。
 *
 * カードの正本はデータ用ブランチにある。読むコマンドは頭で 1 回取り直してから読み、
 * 書くコマンドは検査（`submitRefusal` など）から usecase までを `DataStore.transact` の中で走らせる。
 * push が拒否されると取り直した状態で検査からやり直すので、検査は必ず最新のカードに対して行われる。
 */
export const CARD_USAGE = `使い方: ai-board card <command> [--root <path>]

Commands:
  list                     カードの一覧を JSON で出す（本文を除く。並び順は rank 順）
  show <id>                カードを Markdown（frontmatter + 本文）で出す
  create --title <t> [--id <id>]
                           アイデアカードを作る。本文は標準入力から読む（任意）
  body <id>                本文を標準入力の内容に差し替える
                           （## レビュー のエントリが変わる差し替えは拒否する）
  branch <id> <name>       ブランチを紐付ける。--clear で外す
  submit <id> [--gate <plan|verify>] [--resubmit] [--reason <text>]
                           ## レビュー に提出（--resubmit で再提出）を追記する
                           （--gate はどのゲートへの提出か。既定は plan。
                           plan は着手したカードで、plan が未提出か否決のときにだけ、
                           verify は plan の承認後にだけ書ける）
  hold <id> --gate <plan|verify> --reason <text>
                           ## レビュー に保留を追記する。その手を自分では進められず
                           止まるときに、なぜ止まったか、人に何を決めてほしいかを書く
`;

export interface CardCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** 標準入力を最後まで読む。端末から起動されて入力が無ければ null */
  readonly readStdin: () => Promise<string | null>;
  readonly now: () => Date;
}

/** 引数の解析結果。位置引数とフラグを分けておく */
interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

export interface CardCliDependencies {
  /** データのワークツリー。読む前に取り直し、書き込みは `transact` の中で行う */
  readonly store: Pick<DataStore, 'refresh' | 'transact'>;
  /** `store` のデータのワークツリーを読み書きするカードの依存 */
  readonly cards: CardDependencies;
  /** 移行前の DB（`board.db`）の場所。無ければ null。データ用ブランチが無いときの案内を変える */
  readonly legacyDb: string | null;
}

type Handler = (args: ParsedArgs, deps: CardCliDependencies, io: CardCliIo) => Promise<number>;

/** CLI の検査で書き込みを拒んだ */
interface Refused {
  readonly type: 'Refused';
  readonly message: string;
}

/** リポジトリが書き込みを拒んだ（壊れた `card.md` や `order.yaml`、判断の書き換え） */
interface WriteRefused {
  readonly type: 'WriteRefused';
  readonly reason: string;
}

type WriteFailure = CreateCardError | UpdateCardError | Refused | WriteRefused;

const VALUE_FLAGS = new Set(['--title', '--id', '--reason', '--from', '--gate']);

const HANDLERS: Readonly<Record<string, Handler>> = {
  list: runList,
  show: runShow,
  create: runCreate,
  body: runBody,
  branch: runBranch,
  submit: runSubmit,
  hold: runHold,
};

/** `ai-board card <command>` を実行し、終了コードを返す */
export async function runCardCli(
  argv: readonly string[],
  deps: CardCliDependencies,
  io: CardCliIo
): Promise<number> {
  const [command, ...rest] = argv;
  const handler = command === undefined ? undefined : HANDLERS[command];

  if (handler === undefined) {
    io.stderr(CARD_USAGE);
    return command === undefined || command === '--help' || command === '-h' ? 0 : 1;
  }

  const parsed = parseCommandArgs(rest);
  if (typeof parsed === 'string') {
    io.stderr(`${parsed}\n`);
    return 1;
  }

  return handler(parsed, deps, io);
}

/** `ai-board import`。移行前の Markdown カードを DB に取り込む。既存の ID は上書きしない */
export async function runImport(
  cardsDir: string,
  deps: CardDependencies,
  io: CardCliIo
): Promise<number> {
  const cards = await readCardFiles(cardsDir);
  let imported = 0;

  for (const card of cards) {
    if (await deps.cardRepository.create(card)) {
      imported += 1;
    } else {
      io.stderr(`既に DB にあるため読み飛ばしました: ${card.id}\n`);
    }
  }

  io.stdout(`${imported} 件のカードを取り込みました（${cardsDir}）\n`);
  return 0;
}

/** 引数を位置引数とフラグに分ける。`--root` は呼び出し側で取り除いてある */
export function parseCommandArgs(argv: readonly string[]): ParsedArgs | string {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';

    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    if (!VALUE_FLAGS.has(arg)) {
      flags.set(arg, true);
      continue;
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      return `${arg} には値を指定してください`;
    }
    flags.set(arg, value);
    i += 1;
  }

  return { positionals, flags };
}

// ============================================================
// サブコマンド
// ============================================================

async function runList(
  _args: ParsedArgs,
  deps: CardCliDependencies,
  io: CardCliIo
): Promise<number> {
  if (!(await refreshForRead(deps, io))) return 1;

  const cards = await deps.cards.cardRepository.findAll();
  const summaries = cards.map(({ body: _body, ...meta }) => meta);

  io.stdout(`${JSON.stringify(summaries, null, 2)}\n`);
  return 0;
}

async function runShow(
  args: ParsedArgs,
  deps: CardCliDependencies,
  io: CardCliIo
): Promise<number> {
  const id = requireCardId(args, io);
  if (id === null) return 1;
  if (!(await refreshForRead(deps, io))) return 1;

  const card = await deps.cards.cardRepository.findById(id);
  if (card === null) {
    io.stderr(`カードが見つかりません: ${id}\n`);
    return 1;
  }

  io.stdout(serializeCard(card));
  return 0;
}

async function runCreate(
  args: ParsedArgs,
  deps: CardCliDependencies,
  io: CardCliIo
): Promise<number> {
  const title = args.flags.get('--title');
  if (typeof title !== 'string' || title.trim() === '') {
    io.stderr('--title を指定してください\n');
    return 1;
  }

  const id = args.flags.get('--id');
  const body = await io.readStdin();
  const createdAt = io.now();

  return write(
    deps,
    io,
    (card) => `data: ${card.id} を作る`,
    () =>
      deps.cards.createCardCommand({
        title: title.trim(),
        id: typeof id === 'string' ? id : undefined,
        body: body ?? undefined,
        createdAt,
      })
  );
}

async function runBody(
  args: ParsedArgs,
  deps: CardCliDependencies,
  io: CardCliIo
): Promise<number> {
  const id = requireCardId(args, io);
  if (id === null) return 1;

  const body = await io.readStdin();
  if (body === null) {
    io.stderr('本文を標準入力から渡してください\n');
    return 1;
  }

  return write(deps, io, `data: ${id} の本文を差し替える`, async () => {
    const existing = await deps.cards.cardRepository.findById(id);
    if (existing === null) return err({ type: 'CardNotFound', id });

    // 人の判断はレビューログにだけ残る。本文の差し替えでそれを書き換えさせない
    if (!isDeepStrictEqual(parseReviewLog(existing.body), parseReviewLog(body))) {
      return refused(
        '## レビュー のエントリが変わる差し替えはできません。提出 / 再提出は submit で追記してください'
      );
    }

    return deps.cards.updateCardBodyCommand({ id, body: trimNewlines(body) });
  });
}

async function runBranch(
  args: ParsedArgs,
  deps: CardCliDependencies,
  io: CardCliIo
): Promise<number> {
  const id = requireCardId(args, io);
  if (id === null) return 1;

  const clear = args.flags.get('--clear') === true;
  const name = args.positionals[1];

  if (clear === (name !== undefined)) {
    io.stderr('ブランチ名か --clear のどちらか一方を指定してください\n');
    return 1;
  }

  // コミットにブランチ名は入れない（ID・ゲート・種別だけを入れる）
  const message = clear ? `data: ${id} のブランチを外す` : `data: ${id} にブランチを紐付ける`;

  return write(deps, io, message, () =>
    deps.cards.updateCardMetaCommand({ id, patch: { branch: clear ? null : (name ?? null) } })
  );
}

/**
 * AI の手の区切りを `提出` / `再提出` として残す。
 *
 * plan の提出（再提出を含む）は、人が着手したカードにだけ書ける。plan を飛ばす宣言のあるカードでは
 * 提出がそのまま承認と読まれるので、着手していないカードに書けると、人の着手を経ずにアイデアから
 * 実装中へ進めてしまう。宣言の有無で分けないのは、宣言の無いカードでも着手していないカードに
 * AI が計画を出す道は無く、振る舞いの上で失うものが無いためである。
 *
 * plan の提出は、さらに plan ゲートが未提出（`none`）か否決（`rejected`）のときにだけ書ける。
 * 提出済み・承認済み・保留のカードに書けると、plan を飛ばす宣言のあるカードでは `plan 再提出` が承認と
 * 同じ区切りになり（`currentEntries`）、それより前の人の `verify 否決` を AI の 1 回の呼び出しで消せてしまう。
 * 宣言の無いカードでも、否決を受けずに計画を出し直す手は無いので、宣言の有無で分けない。
 *
 * verify の提出は plan の通過を前提にするので、着手の条件は重ねない。
 */
async function runSubmit(
  args: ParsedArgs,
  deps: CardCliDependencies,
  io: CardCliIo
): Promise<number> {
  const id = requireCardId(args, io);
  if (id === null) return 1;

  const gate = parseGate(args.flags.get('--gate'));
  if (gate === null) {
    io.stderr(`--gate には plan か verify を指定してください\n${CARD_USAGE}`);
    return 1;
  }

  const reason = args.flags.get('--reason');
  const kind = args.flags.get('--resubmit') === true ? '再提出' : '提出';
  const at = io.now();

  return write(deps, io, `data: ${id} に ${gate} ${kind} を足す`, async () => {
    const refusal = await submitRefusal(id, gate, deps.cards);
    if (refusal !== null) return refused(refusal);

    return deps.cards.appendReviewCommand({
      id,
      gate,
      kind,
      reason: typeof reason === 'string' ? reason : '',
      at,
    });
  });
}

/**
 * AI が手を進められずに止まったことを `保留` として残す。
 *
 * 保留はゲートを先へ進めない（どの規則も `held` で前へ進まない）。人が後から承認 / 否決 / 中止を書けば
 * それがゲートの最新エントリになり、保留は自然に外れる。ゲートは取り違えると別の手の止まりになるので
 * 既定を置かず、理由は人が次に何をするかを決める材料なので必須にする。
 *
 * 書けるのは、そのゲートの最新の判断が 否決 のときだけにする。AI が保留を書くのは否決を直す手
 * （`revise-plan` / `revise-impl`）で止まるときだけで、それ以外で書けると、承認済みの plan に保留を書いて
 * 人の承認を打ち消したり、計画レビュー / 動作確認 で人を待つカードを AI の列へ落としたりできてしまう。
 */
async function runHold(
  args: ParsedArgs,
  deps: CardCliDependencies,
  io: CardCliIo
): Promise<number> {
  const id = requireCardId(args, io);
  if (id === null) return 1;

  const gateFlag = args.flags.get('--gate');
  const gate = gateFlag === undefined ? null : parseGate(gateFlag);
  if (gate === null) {
    io.stderr(`--gate には plan か verify を指定してください\n${CARD_USAGE}`);
    return 1;
  }

  const reason = args.flags.get('--reason');
  if (typeof reason !== 'string' || reason.trim() === '') {
    io.stderr('--reason に、なぜ止まったか、人に何を決めてほしいかを書いてください\n');
    return 1;
  }

  const at = io.now();

  return write(deps, io, `data: ${id} に ${gate} 保留 を足す`, async () => {
    if (!(await gateRejected(id, gate, deps.cards))) {
      return refused(`保留は ${gate} の最新の判断が否決のときにしか書けません`);
    }

    return deps.cards.appendReviewCommand({ id, gate, kind: '保留', reason: reason.trim(), at });
  });
}

// ============================================================
// データ用ブランチの読み書き
// ============================================================

/**
 * 読む前に 1 回取り直す。読めなければ理由を出して false。
 *
 * fetch に失敗したとき（オフライン）は、警告を出して手元の内容で読む。
 */
async function refreshForRead(deps: CardCliDependencies, io: CardCliIo): Promise<boolean> {
  const refreshed = await deps.store.refresh();
  if (isErr(refreshed)) {
    io.stderr(`${describeDataStoreError(refreshed.error, deps.legacyDb)}\n`);
    return false;
  }

  if (refreshed.value.kind === 'offline') {
    io.stderr(`${describeOfflineRead(refreshed.value.reason)}\n`);
  }
  return true;
}

/**
 * 検査から usecase までを、書き込みの 1 操作（`transact`）の中で走らせる。
 *
 * `op` は push が拒否されると取り直した状態で頭から呼び直されるので、標準出力にも標準エラーにも書かない。
 * 拒むときは Err を返す（`transact` が書きかけのファイルを捨て、コミットしない）。
 * 出力は `transact` が返ってから 1 回だけ行う。
 */
async function write(
  deps: CardCliDependencies,
  io: CardCliIo,
  message: CommitMessage<Card>,
  op: () => Promise<Result<Card, WriteFailure>>
): Promise<number> {
  const result = await deps.store.transact<Card, WriteFailure>(message, async () => {
    try {
      return await op();
    } catch (error) {
      if (error instanceof CardWriteRefusedError) {
        return err({ type: 'WriteRefused', reason: error.reason.type });
      }
      throw error;
    }
  });

  return report(result, deps, io);
}

function refused(message: string): Result<never, Refused> {
  return err({ type: 'Refused', message });
}

// ============================================================
// ヘルパー
// ============================================================

/** 前後の改行だけを落とす。Markdown の行頭の空白は意味を持つので trim しない */
function trimNewlines(text: string): string {
  return text.replace(/^\n+/, '').replace(/\n+$/, '');
}

/**
 * 提出を拒む理由。書いてよければ null。カードが無ければ null を返し、見つからない旨は追記の usecase に任せる。
 *
 * - plan: 人が着手していて、plan ゲートが未提出か否決のときだけ書ける（`runSubmit` を参照）
 * - verify: plan ゲートを通過しているときだけ書ける。plan の承認前に書かれた verify 提出は、承認の後には
 *   数えられない（`gateStates` が前のゲートの承認より古いエントリを外す）。それでもログには残り、
 *   読む人を惑わせるので、書く時点で拒む
 */
async function submitRefusal(
  id: CardId,
  gate: ReviewGate,
  deps: CardDependencies
): Promise<string | null> {
  const card = await deps.cardRepository.findById(id);
  if (card === null) return null;

  const plan = gateStates(parseReviewLog(card.body), card.skipGates).plan;

  if (gate === 'verify') {
    return plan === 'approved' ? null : 'verify の提出は plan の承認後にしかできません';
  }
  if (card.startedAt === null) {
    return 'plan の提出は着手したカードにしかできません（着手は人が指示します）';
  }
  if (plan !== 'none' && plan !== 'rejected') {
    return `plan の提出は、plan が未提出か否決のときにしかできません（今の plan ゲート: ${plan}）`;
  }
  return null;
}

/** そのゲートの最新の判断が否決か。カードが無ければ true を返し、見つからない旨は追記の usecase に任せる */
async function gateRejected(
  id: CardId,
  gate: ReviewGate,
  deps: CardDependencies
): Promise<boolean> {
  const card = await deps.cardRepository.findById(id);
  if (card === null) return true;

  return gateStates(parseReviewLog(card.body), card.skipGates)[gate] === 'rejected';
}

/** `--gate` の値。省略は plan。規定外の値は null */
function parseGate(value: string | true | undefined): ReviewGate | null {
  if (value === undefined) return 'plan';
  return typeof value === 'string' && isReviewGate(value) ? value : null;
}

function requireCardId(args: ParsedArgs, io: CardCliIo): CardId | null {
  const parsed = CardIdSchema.safeParse(args.positionals[0]);

  if (!parsed.success) {
    io.stderr('カード ID（kebab-case）を指定してください\n');
    return null;
  }

  return parsed.data as CardId;
}

/** 成功なら書き込んだカードの ID を出す。失敗なら理由を stderr に出す */
function report(
  result: Result<Card, WriteFailure | DataStoreError>,
  deps: CardCliDependencies,
  io: CardCliIo
): number {
  if (result.ok) {
    io.stdout(`${result.value.id}\n`);
    return 0;
  }

  io.stderr(`${describeError(result.error, deps.legacyDb)}\n`);
  return 1;
}

function describeError(error: WriteFailure | DataStoreError, legacyDb: string | null): string {
  switch (error.type) {
    case 'CardNotFound':
      return `カードが見つかりません: ${error.id}`;
    case 'DuplicateCardId':
      return `同じ ID のカードが既にあります: ${error.id}`;
    case 'InvalidCardId':
      return `カード ID が不正です: ${error.reason}`;
    case 'Refused':
      return error.message;
    case 'WriteRefused':
      return `カードのファイルへの書き込みを拒みました（${error.reason}）`;
    case 'DataBranchMissing':
    case 'DataDirNotRepository':
    case 'DataStoreLockTimeout':
    case 'DataStoreFetchFailed':
    case 'DataStorePushFailed':
    case 'DataStoreGitFailed':
      return describeDataStoreError(error, legacyDb);
  }
}
