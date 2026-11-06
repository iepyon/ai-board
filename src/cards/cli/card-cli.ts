import { isErr, type Result } from '../../shared/result.js';
import { CardIdSchema, type CardId } from '../../shared/schemas/common.js';
import type { DataStore, DataStoreError } from '../../infrastructure/data-store.js';
import type { CardDependencies } from '../composition.js';
import type { CardWriteCommands } from '../usecases/commands/card-write.commands.js';
import type { Card } from '../models/card.js';
import type {
  CreateCardError,
  HoldReviewError,
  SubmitReviewError,
  UpdateCardBodyError,
  UpdateCardError,
} from '../errors/card-errors.js';
import { serializeCard } from '../repositories/card-markdown.js';
import { isReviewGate, REVIEW_GATES, type ReviewGate } from '../models/review.js';
import { describeDataStoreError, describeOfflineRead } from './data-store-messages.js';
import { readSeedCards, type SeedFile } from './seed-cards.js';

// ============================================================
// ai-board card — エージェントがカードに書くための CLI
// ============================================================

/**
 * エージェントに許す操作だけを並べる。
 *
 * `startedAt`・`rank`・`skipGates` の書き換えと、承認 / 差し戻し / 中止の追記は
 * 人の判断であり、ここには入口を置かない（`ai-board decide` からだけ書く）。
 * 本文の差し替えも、`## レビュー` のエントリを変えるものは拒否する
 * （検査は本文の差し替えの usecase が持ち、CLI はその `ReviewEntriesChanged` を出すだけにする）。
 * 提出 / 保留も、書けるかの検査は提出と保留の usecase が持つ。どちらも種別を中で決めるので、
 * この CLI には承認 / 差し戻し / 中止を書く口が型の上でも無い（`CardCliDependencies.writes` に人の判断を書く口が無い）。
 * 提出 / 保留の判断は値のままリポジトリに渡すので、理由にどんな行を書いても判断は 1 件しか増えない。
 *
 * カードの正本はデータ用ブランチにある。読むコマンドは頭で 1 回取り直してから読み、
 * 書くコマンドは書き込みの usecase（`writes`）を呼ぶ。usecase が検査から書き込みまでを `DataStore.transact` の中で走らせ、
 * コミットのメッセージも決める。push が拒否されると取り直した状態で検査からやり直すので、検査は必ず最新のカードに対して行われる。
 */
export const CARD_USAGE = `使い方: ai-board card <command> [--root <path>]

Commands:
  list                     カードの一覧を JSON で出す（本文を除く。並び順は rank 順）
  show <id>                カードを Markdown（frontmatter + 本文）で出す
  create --title <t> [--id <id>]
                           アイデアカードを作る。本文は標準入力から読む（任意）
  seed --from <dir>        <dir> の *.md（show と同じ形）のうち、まだ無いカードだけを
                           アイデアカードとして作る。既にある ID は飛ばす。読むのは id・title・本文だけ。
                           1 つでも読めないファイルがあれば 1 枚も作らない
  body <id>                本文を標準入力の内容に差し替える
                           （## レビュー のエントリが変わる差し替えは拒否する）
  branch <id> <name>       ブランチを紐付ける。--clear で外す
  submit <id> [--gate plan] [--resubmit] [--reason <text>]
                           ## レビュー に提出（--resubmit で再提出）を追記する
                           （--gate はどのゲートへの提出か。plan だけで、既定も plan。
                           着手したカードで、plan が未提出か差し戻されたときにだけ書ける）
  hold <id> --gate plan --reason <text>
                           ## レビュー に保留を追記する。その手を自分では進められず
                           止まるときに、なぜ止まったか、人に何を決めてほしいかを書く
`;

export interface CardCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** 標準入力を最後まで読む。端末から起動されて入力が無ければ null */
  readonly readStdin: () => Promise<string | null>;
  /**
   * ディレクトリの直下の `*.md` を読む（`seed` が使う。下の階層は読まない）。相対パスは作業ディレクトリから解決する。
   * 読めなければ理由の文を返す
   */
  readonly readMarkdownDir: (dir: string) => Promise<Result<readonly SeedFile[], string>>;
  readonly now: () => Date;
}

/** 引数の解析結果。位置引数とフラグを分けておく */
interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

export interface CardCliDependencies {
  /** データのワークツリー。読む前に取り直す */
  readonly store: Pick<DataStore, 'refresh'>;
  /** `store` のデータのワークツリーのカードを読む */
  readonly cards: Pick<CardDependencies, 'cardRepository'>;
  /**
   * AI に許す書き込みだけ（起票・本文・ブランチの紐付け・提出 / 再提出・保留）。
   * 人の判断を書く口（承認 / 差し戻し / 中止の追記と、`startedAt` / `skipGates` の書き換え）は無い
   */
  readonly writes: CardWriteCommands;
}

type Handler = (args: ParsedArgs, deps: CardCliDependencies, io: CardCliIo) => Promise<number>;

/** 書き込みの usecase のエラー。リポジトリの拒否（`CardWriteRefused`）と `transact` の失敗が含まれる */
type WriteFailure =
  CreateCardError | UpdateCardError | UpdateCardBodyError | SubmitReviewError | HoldReviewError;

const VALUE_FLAGS = new Set(['--title', '--id', '--reason', '--from', '--gate']);

const HANDLERS: Readonly<Record<string, Handler>> = {
  list: runList,
  show: runShow,
  create: runCreate,
  seed: runSeed,
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

  return report(
    await deps.writes.create({
      title: title.trim(),
      id: typeof id === 'string' ? id : undefined,
      body: body ?? undefined,
      createdAt,
    }),
    io
  );
}

/**
 * 題材のカードの一式を起票する。
 *
 * 先に全部読み、1 つでも読めないファイルがあれば 1 枚も書かない（チームで 1 つの fork を共有するので、
 * 一部だけ起票されると誰が何を直すかが分かりにくい）。
 * 起票は 1 枚ずつ `card create` と同じ口で行い、1 枚 1 コミットにする。既にある ID は失敗にせず飛ばすので、
 * 何度走らせても重複しない。途中で失敗したら止まり、それまでに起票した分は残る（次に走らせれば続きから起票される）。
 * `rank`・`startedAt`・`## レビュー` は書かない。本文の `## レビュー` に判断があれば起票の口が拒む。
 */
async function runSeed(
  args: ParsedArgs,
  deps: CardCliDependencies,
  io: CardCliIo
): Promise<number> {
  const from = args.flags.get('--from');
  if (typeof from !== 'string') {
    io.stderr('--from に題材のディレクトリを指定してください\n');
    return 1;
  }

  const files = await io.readMarkdownDir(from);
  if (isErr(files)) {
    io.stderr(`${from} を読めません: ${files.error}\n`);
    return 1;
  }

  const read = readSeedCards(files.value);
  if (isErr(read)) {
    const lines = read.error.map((problem) => `${problem.file}: ${problem.reason}`);
    io.stderr(`${lines.join('\n')}\n読めないファイルがあるので、1 枚も起票しませんでした\n`);
    return 1;
  }
  if (read.value.length === 0) {
    io.stderr(`${from} に *.md がありません\n`);
    return 1;
  }

  // 既にある ID は、書き込み（fetch・ロック・push）を経ずに飛ばす。取り直しは頭の 1 回だけにする
  if (!(await refreshForRead(deps, io))) return 1;
  const existing = new Set((await deps.cards.cardRepository.findAll()).map((card) => card.id));

  for (const card of read.value) {
    if (existing.has(card.id)) {
      io.stdout(`${card.id}: 既にあるので飛ばしました\n`);
      continue;
    }

    const createdAt = io.now();
    const result = await deps.writes.create({
      title: card.title,
      id: card.id,
      body: card.body,
      createdAt,
    });

    if (result.ok) {
      io.stdout(`${card.id}: 起票しました\n`);
    } else if (result.error.type === 'DuplicateCardId') {
      // 頭の取り直しの後に、ほかの人が同じ ID を起票していた
      io.stdout(`${card.id}: 既にあるので飛ばしました\n`);
    } else {
      io.stderr(`${card.file}: ${describeError(result.error)}\n`);
      return 1;
    }
  }
  return 0;
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

  // 人の判断はレビューログにだけ残る。エントリが変わる差し替えは usecase が ReviewEntriesChanged で拒む
  return report(await deps.writes.replaceBody({ id, body: trimNewlines(body) }), io);
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

  return report(await deps.writes.linkBranch({ id, branch: clear ? null : (name ?? null) }), io);
}

/**
 * AI の手の区切りを `提出` / `再提出` として残す。
 *
 * 書けるか（着手したカードで、ゲートが未提出か差し戻しか）は提出の usecase が確かめる（`submitReviewCommand`）。
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
    io.stderr(`${GATE_ERROR}\n${CARD_USAGE}`);
    return 1;
  }

  const reason = args.flags.get('--reason');

  const resubmit = args.flags.get('--resubmit') === true;

  return report(
    await deps.writes.submit({
      id,
      gate,
      resubmit,
      reason: typeof reason === 'string' ? reason : '',
      at: io.now(),
    }),
    io
  );
}

/**
 * AI が手を進められずに止まったことを `保留` として残す。
 *
 * ゲートは取り違えると別の手の止まりになるので既定を置かず、理由は人が次に何をするかを決める材料なので必須にする。
 * 書けるか（ゲートの最新の判断が差し戻しか）は保留の usecase が確かめる（`holdReviewCommand`）。
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
    io.stderr(`${GATE_ERROR}\n${CARD_USAGE}`);
    return 1;
  }

  const reason = args.flags.get('--reason');
  if (typeof reason !== 'string' || reason.trim() === '') {
    io.stderr('--reason に、なぜ止まったか、人に何を決めてほしいかを書いてください\n');
    return 1;
  }

  return report(await deps.writes.hold({ id, gate, reason: reason.trim(), at: io.now() }), io);
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
    io.stderr(`${describeDataStoreError(refreshed.error)}\n`);
    return false;
  }

  if (refreshed.value.kind === 'offline') {
    io.stderr(`${describeOfflineRead(refreshed.value.reason)}\n`);
  }
  return true;
}

// ============================================================
// ヘルパー
// ============================================================

/** 前後の改行だけを落とす。Markdown の行頭の空白は意味を持つので trim しない */
function trimNewlines(text: string): string {
  return text.replace(/^\n+/, '').replace(/\n+$/, '');
}

/** `--gate` が規定外のときの文。ゲートの一覧から作り、ゲートが変わっても書き直さずに済むようにする */
const GATE_ERROR = `--gate には ${REVIEW_GATES.join(' か ')} を指定してください`;

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
function report(result: Result<Card, WriteFailure | DataStoreError>, io: CardCliIo): number {
  if (result.ok) {
    io.stdout(`${result.value.id}\n`);
    return 0;
  }

  io.stderr(`${describeError(result.error)}\n`);
  return 1;
}

function describeError(error: WriteFailure | DataStoreError): string {
  switch (error.type) {
    case 'CardNotFound':
      return `カードが見つかりません: ${error.id}`;
    case 'DuplicateCardId':
      return `同じ ID のカードが既にあります: ${error.id}`;
    case 'InvalidCardId':
      return `カード ID が不正です: ${error.reason}`;
    case 'SubmitBeforeStart':
      return 'plan の提出は着手したカードにしかできません（着手は人が指示します）';
    case 'SubmitGateClosed':
      return `${error.gate} の提出は、${error.gate} が未提出か差し戻されたときにしかできません（今の ${error.gate} ゲート: ${error.state}）`;
    case 'HoldGateNotRejected':
      return `保留は ${error.gate} の最新の判断が差し戻しのときにしか書けません`;
    case 'CardWriteRefused':
      return `カードのファイルへの書き込みを拒みました（${error.reason}）`;
    case 'ReviewEntriesChanged':
      return '## レビュー のエントリが変わる差し替えはできません。提出 / 再提出は submit で追記してください';
    default:
      // 残りは DataStoreError。describeDataStoreError の switch が種別を網羅する
      return describeDataStoreError(error);
  }
}
