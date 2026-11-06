import { isErr, type Result } from '../../shared/result.js';
import { CardIdSchema, type CardId, type Stage } from '../../shared/schemas/common.js';
import { DIVIDER_ID } from '../../shared/card-reorder.js';
import { STAGE_LABELS } from '../../shared/stage-labels.js';
import { withSkipGate } from '../../shared/stage-gates.js';
import { decisionsFor } from '../../shared/dashboard-sections.js';
import { REVIEW_GATES, isReviewGate, type ReviewGate } from '../../cards/models/review.js';
import type { CardDependencies } from '../../cards/composition.js';
import type { Card } from '../../cards/models/card.js';
import type { CardWriteFailure, MoveCardError } from '../../cards/errors/card-errors.js';
import { describeDataStoreError } from '../../cards/cli/data-store-messages.js';
import type { OrderRef } from '../../cards/usecases/commands/move-in-order.js';
import type { Board, BoardCard } from '../models/board-card.js';
import type { GetBoardError } from '../errors/board-errors.js';
import {
  guardMove,
  guardMoveDivider,
  guardReview,
  guardSkip,
  guardStartedAt,
  type DecideRefusal,
} from '../services/decision-guards.js';
import { describeForge } from './status-describe.js';

// ============================================================
// ai-board decide — 人がチャットで頼んだ判断を書くための CLI
// ============================================================

/**
 * 人の判断（承認 / 否決 / 中止、着手 / 着手を戻す、飛ばす宣言、並べ替え）を書く。
 *
 * 画面のボタンと同じ usecase を、サーバと同じ組み立て（`createTransactionalCardDependencies`）で呼ぶ。
 * 書く前にボードを導出し、画面で押せない判断（`decisionsFor` / `droppableStages` / アイデアの表に無いもの）は拒む。
 *
 * 誰が使ってよいかは構造では分けない。人と、人がこの会話で自分の言葉で頼んだ Claude（`board-decide` のスキル）が使い、
 * `board-reviewer` とループの周の中では使わない。この境界は手順書の決まりで守る（ADR 0007）。
 * AI が書いてよいもの（本文・ブランチ・提出 / 再提出 / 保留）は `ai-board card` にあり、ここには入れない。
 */
export const DECIDE_USAGE = `使い方: ai-board decide <command> [--root <path>]

人の判断を書く。人と、人がこの会話で自分の言葉で頼んだ Claude（board-decide）だけが使う。
board-reviewer とループの周の中では使わない。画面で押せない判断は拒む。

Commands:
  approve <id> [--reason <text>]   plan を承認する
  reject <id> --reason <text>      plan を否決する（理由は必須）
  abort <id> [--reason <text>]     中止する
  start <id>                       着手する（アイデア → 計画提案中）
  unstart <id>                     着手を戻す（計画提案中 → アイデア）
  skip <id> --gate plan [--remove] 計画レビューを飛ばす宣言を入れる（--remove で外す）
  move <id> --after <ref> --before <ref>
                                   アイデアの表で、<id> を after と before の間へ動かす
                                   （<ref> はカード ID、区切り線の ${DIVIDER_ID}、端なら none）
  move-divider --after <ref> --before <ref>
                                   アイデアの表の区切り線を動かす（<ref> はカード ID か none）
`;

export interface DecideCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now: () => Date;
}

export interface DecideCliDependencies {
  /**
   * ボードを導出する。初めの呼び出しでデータ用ブランチと PR の状態を取り直し、
   * 書いた後の呼び出しでは取り直した PR の状態のまま組み立て直す（列の移りを出すため）
   */
  readonly loadBoard: () => Promise<Result<Board, GetBoardError>>;
  /** 書き込みは人の API と同じ usecase。それぞれ `DataStore.transact` の中で走る */
  readonly cards: Pick<
    CardDependencies,
    'appendReviewCommand' | 'updateCardMetaCommand' | 'moveCardCommand' | 'moveIdeaDividerCommand'
  >;
}

interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

type Handler = (args: ParsedArgs, deps: DecideCliDependencies, io: DecideCliIo) => Promise<number>;

const VALUE_FLAGS = new Set(['--reason', '--gate', '--after', '--before']);

/**
 * サブコマンドごとの、実行する関数・受けるフラグ・位置引数の数。
 * 外れた引数は、ボードを読む前に拒む。打ち間違えたフラグ（`--remov`、`--reson`）を黙って捨てると、
 * 宣言を外すつもりで入れる、理由の無い判断を書く、といった頼んだものと違う判断になるため。
 */
interface Command {
  readonly run: Handler;
  readonly flags: readonly string[];
  readonly positionals: number;
}

const COMMANDS: Readonly<Record<string, Command>> = {
  approve: { run: (a, d, io) => runReview('承認', a, d, io), flags: ['--reason'], positionals: 1 },
  reject: { run: (a, d, io) => runReview('否決', a, d, io), flags: ['--reason'], positionals: 1 },
  abort: { run: (a, d, io) => runReview('中止', a, d, io), flags: ['--reason'], positionals: 1 },
  start: { run: runStart, flags: [], positionals: 1 },
  unstart: { run: runUnstart, flags: [], positionals: 1 },
  skip: { run: runSkip, flags: ['--gate', '--remove'], positionals: 1 },
  move: { run: runMove, flags: ['--after', '--before'], positionals: 1 },
  'move-divider': { run: runMoveDivider, flags: ['--after', '--before'], positionals: 0 },
};

/** 規定のサブコマンドを引く。`constructor` などのプロトタイプのプロパティは通さない */
function lookupCommand(command: string | undefined): Command | undefined {
  return command !== undefined && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
}

/** `ai-board decide <command>` を実行し、終了コードを返す */
export async function runDecideCli(
  argv: readonly string[],
  deps: DecideCliDependencies,
  io: DecideCliIo
): Promise<number> {
  const [command, ...rest] = argv;
  const spec = lookupCommand(command);

  if (spec === undefined) {
    io.stderr(DECIDE_USAGE);
    return command === undefined || command === '--help' || command === '-h' ? 0 : 1;
  }

  const parsed = parseArgs(rest, spec);
  if (typeof parsed === 'string') return fail(io, parsed);

  return spec.run(parsed, deps, io);
}

/** 規定のサブコマンドか。呼び出し側は、そうでなければデータ用ブランチと PR の取り直しを起こさずに使い方を出す */
export function isDecideCommand(command: string | undefined): boolean {
  return lookupCommand(command) !== undefined;
}

function parseArgs(argv: readonly string[], spec: Command): ParsedArgs | string {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';

    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    if (!spec.flags.includes(arg)) {
      return `知らないオプションです: ${arg}（このコマンドが受けるのは ${spec.flags.length === 0 ? 'なし' : spec.flags.join(' / ')}）`;
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

  if (positionals.length > spec.positionals) {
    return `余分な引数があります: ${positionals.slice(spec.positionals).join(' ')}`;
  }

  return { positionals, flags };
}

// ============================================================
// 承認 / 否決 / 中止
// ============================================================

async function runReview(
  kind: '承認' | '否決' | '中止',
  args: ParsedArgs,
  deps: DecideCliDependencies,
  io: DecideCliIo
): Promise<number> {
  const id = requireCardId(args, io);
  if (id === null) return 1;

  const reasonFlag = args.flags.get('--reason');
  const reason = typeof reasonFlag === 'string' ? reasonFlag.trim() : '';

  const board = await loadBoard(deps, io);
  if (board === null) return 1;

  const target = guardReview(board, { id, kind, reason });
  if (!target.ok) return fail(io, describeRefusal(target.error));
  const { card, gate } = target.value;

  const result = await deps.cards.appendReviewCommand({ id, gate, kind, reason, at: io.now() });

  return reportWrite(result, `${gate} ${kind}`, card, deps, io);
}

// ============================================================
// 着手 / 着手を戻す / 飛ばす宣言
// ============================================================

async function runStart(
  args: ParsedArgs,
  deps: DecideCliDependencies,
  io: DecideCliIo
): Promise<number> {
  return runStartedAt(args, deps, io, {
    from: 'idea',
    to: 'planning',
    label: '着手',
    startedAt: () => io.now().toISOString(),
  });
}

async function runUnstart(
  args: ParsedArgs,
  deps: DecideCliDependencies,
  io: DecideCliIo
): Promise<number> {
  return runStartedAt(args, deps, io, {
    from: 'planning',
    to: 'idea',
    label: '着手を戻す',
    startedAt: () => null,
  });
}

/** カードを隣の列へ入れるのと同じ。今の列と、入れられる列（`droppableStages`）を確かめる（`guardStartedAt`） */
async function runStartedAt(
  args: ParsedArgs,
  deps: DecideCliDependencies,
  io: DecideCliIo,
  move: {
    readonly from: Stage;
    readonly to: Stage;
    readonly label: string;
    readonly startedAt: () => string | null;
  }
): Promise<number> {
  const id = requireCardId(args, io);
  if (id === null) return 1;

  const board = await loadBoard(deps, io);
  if (board === null) return 1;

  const guarded = guardStartedAt(board, { id, from: move.from, to: move.to });
  if (!guarded.ok) return fail(io, describeRefusal(guarded.error, move.label));
  const card = guarded.value;

  const result = await deps.cards.updateCardMetaCommand({
    id,
    patch: { startedAt: move.startedAt() },
  });

  return reportWrite(result, move.label, card, deps, io);
}

async function runSkip(
  args: ParsedArgs,
  deps: DecideCliDependencies,
  io: DecideCliIo
): Promise<number> {
  const id = requireCardId(args, io);
  if (id === null) return 1;

  const gateFlag = args.flags.get('--gate');
  if (typeof gateFlag !== 'string' || !isReviewGate(gateFlag)) {
    return fail(io, `--gate には ${REVIEW_GATES.join(' か ')} を指定してください`);
  }
  const gate: ReviewGate = gateFlag;
  const remove = args.flags.get('--remove') === true;

  const board = await loadBoard(deps, io);
  if (board === null) return 1;

  const guarded = guardSkip(board, { id });
  if (!guarded.ok) return fail(io, describeRefusal(guarded.error));
  const card = guarded.value;

  // 画面のチェックボックスと同じく、1 つのゲートだけを出し入れする
  const skipGates = withSkipGate(card.skipGates, gate, !remove);

  const result = await deps.cards.updateCardMetaCommand({ id, patch: { skipGates } });

  return reportWrite(result, `${gate} を飛ばす宣言を${remove ? '外す' : '入れる'}`, card, deps, io);
}

// ============================================================
// 並べ替え
// ============================================================

async function runMove(
  args: ParsedArgs,
  deps: DecideCliDependencies,
  io: DecideCliIo
): Promise<number> {
  const id = requireCardId(args, io);
  if (id === null) return 1;

  const refs = parseRefs(args, true);
  if ('error' in refs) return fail(io, refs.error);
  const { after, before } = refs;
  if (after === id || before === id) {
    return fail(io, '自分自身を隣に指定することはできません');
  }

  const board = await loadBoard(deps, io);
  if (board === null) return 1;

  const guarded = guardMove(board, { id, after, before });
  if (!guarded.ok) return fail(io, describeRefusal(guarded.error));

  const result = await deps.cards.moveCardCommand({
    id,
    after: after as OrderRef | null,
    before: before as OrderRef | null,
  });

  if (!result.ok) return fail(io, describeMoveError(result.error));
  io.stdout(`${id}: 並べ替えました\n`);
  return 0;
}

async function runMoveDivider(
  args: ParsedArgs,
  deps: DecideCliDependencies,
  io: DecideCliIo
): Promise<number> {
  const refs = parseRefs(args, false);
  if ('error' in refs) return fail(io, refs.error);
  const { after, before } = refs;

  const board = await loadBoard(deps, io);
  if (board === null) return 1;

  const guarded = guardMoveDivider(board, { after, before });
  if (!guarded.ok) return fail(io, describeRefusal(guarded.error));

  const result = await deps.cards.moveIdeaDividerCommand({
    after: after as CardId | null,
    before: before as CardId | null,
  });

  if (!result.ok) return fail(io, describeMoveError(result.error));
  io.stdout('区切り線を動かしました\n');
  return 0;
}

/** `--after` / `--before` の値。`none` は端（null）。区切り線（`DIVIDER_ID`）は `allowDivider` のときだけ受ける */
function parseRefs(
  args: ParsedArgs,
  allowDivider: boolean
): { readonly after: string | null; readonly before: string | null } | { readonly error: string } {
  const allowed = allowDivider ? `カード ID・${DIVIDER_ID}・none` : 'カード ID か none';
  const parse = (flag: string): { ref: string | null } | { error: string } => {
    const value = args.flags.get(flag);
    if (typeof value !== 'string') return { error: `${flag} に ${allowed} を指定してください` };
    if (value === 'none') return { ref: null };
    if (allowDivider && value === DIVIDER_ID) return { ref: DIVIDER_ID };
    if (!CardIdSchema.safeParse(value).success) {
      return { error: `${flag} には ${allowed} を指定してください: ${value}` };
    }
    return { ref: value };
  };

  const after = parse('--after');
  if ('error' in after) return after;
  const before = parse('--before');
  if ('error' in before) return before;
  return { after: after.ref, before: before.ref };
}

// ============================================================
// ヘルパー
// ============================================================

async function loadBoard(deps: DecideCliDependencies, io: DecideCliIo): Promise<Board | null> {
  const result = await deps.loadBoard();
  if (isErr(result)) {
    io.stderr(`ボードを読めませんでした: ${result.error.reason}\n`);
    return null;
  }
  return result.value;
}

function requireCardId(args: ParsedArgs, io: DecideCliIo): CardId | null {
  const parsed = CardIdSchema.safeParse(args.positionals[0]);
  if (!parsed.success) {
    io.stderr('カード ID（kebab-case）を指定してください\n');
    return null;
  }
  return parsed.data as CardId;
}

/**
 * 判断を書けない理由の 1 行。`label` は着手 / 着手を戻すのときの操作の名前（`StageMismatch` で使う）。
 *
 * GitHub に繋がらないときは、PR の状態が引けないと計画レビューのカードが手前の列に落ちて見え、
 * 出せる判断や戻せる列を取り違えるので拒む（`status` が `next` を `null` にするのと同じ理由）。
 */
function describeRefusal(refusal: DecideRefusal, label = ''): string {
  switch (refusal.type) {
    case 'ForgeUnavailable': {
      const what = refusal.action === 'review' ? '承認 / 否決 / 中止' : '着手 / 着手を戻す';
      return `GitHub に繋がらないので、${what}は書けません（GitHub: ${describeForge(refusal.forge)}）`;
    }
    case 'CardNotFound':
      return `カードが見つかりません: ${refusal.id}`;
    case 'DecisionUnavailable':
      return `${refusal.id} に ${refusal.kind} は書けません（${describeChoices(refusal.card)}）`;
    case 'ReasonRequired':
      return `${refusal.kind}には --reason で理由を書いてください`;
    case 'StageMismatch':
      return (
        `${refusal.id} は${label}できません（今の列: ${STAGE_LABELS[refusal.card.stage]}。` +
        `${STAGE_LABELS[refusal.from]}にあり、${STAGE_LABELS[refusal.to]}へ入れられるカードだけ）` +
        forgeHoldNote(refusal.card)
      );
    case 'CardAborted':
      return `${refusal.id} は中止されているので、飛ばす宣言を変えられません`;
    case 'NotInIdeaTable':
      return `アイデアの表に無いカードです: ${refusal.ref}`;
  }
}

/**
 * PR の状態を引けない止まりなら、その理由を添える。
 * そのカードは出せる判断も入れられる列も無い（`decisionsFor` / `droppableStages`）ので、拒んだ理由がそれだと分かるようにする
 */
function forgeHoldNote(card: BoardCard): string {
  return card.hold?.kind === 'forge' ? `。${card.hold.reason}` : '';
}

function describeChoices(card: BoardCard): string {
  const stage = `今の列: ${STAGE_LABELS[card.stage]}${card.aborted ? '（中止済み）' : ''}`;
  const decisions = decisionsFor(card);
  if (decisions.length === 0) return `${stage}。出せる判断はありません${forgeHoldNote(card)}`;
  return `${stage}。出せる判断: ${decisions.map((d) => `${d.gate} ${d.kind}`).join(' / ')}`;
}

/**
 * 書いた結果を出す。成功なら、書き直したボードで列の移りを 1 行で出す
 * （`board-decide` はこの行を人に伝える）。
 */
async function reportWrite(
  result: Result<Card, CardWriteFailure | { readonly type: 'CardNotFound'; readonly id: string }>,
  what: string,
  before: BoardCard,
  deps: DecideCliDependencies,
  io: DecideCliIo
): Promise<number> {
  if (!result.ok) return fail(io, describeWriteError(result.error));

  const after = await deps.loadBoard();
  const stage = after.ok ? after.value.cards.find((c) => c.id === before.id)?.stage : undefined;
  const transition =
    stage === undefined
      ? '書いた後の列は読めませんでした'
      : stage === before.stage
        ? STAGE_LABELS[stage]
        : `${STAGE_LABELS[before.stage]} → ${STAGE_LABELS[stage]}`;

  io.stdout(`${before.id}: ${what} を書きました（${transition}）\n`);
  return 0;
}

function describeWriteError(
  error: CardWriteFailure | { readonly type: 'CardNotFound'; readonly id: string }
): string {
  switch (error.type) {
    case 'CardNotFound':
      return `カードが見つかりません: ${error.id}`;
    case 'CardWriteRefused':
      return `カードのファイルへの書き込みを拒みました（${error.reason}）`;
    default:
      return describeDataStoreError(error);
  }
}

function describeMoveError(error: MoveCardError): string {
  switch (error.type) {
    case 'StaleOrder':
      return `--after（${error.after}）と --before（${error.before}）の並びが今の表と逆です。status で並びを読み直してください`;
    default:
      return describeWriteError(error);
  }
}

function fail(io: DecideCliIo, message: string): number {
  io.stderr(`${message}\n`);
  return 1;
}
