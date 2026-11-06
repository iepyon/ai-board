import { CardIdSchema, type CardId, type Stage } from '../../shared/schemas/common.js';
import { DIVIDER_ID } from '../../shared/card-reorder.js';
import { STAGE_LABELS } from '../../shared/stage-labels.js';
import { decisionsFor } from '../../shared/dashboard-sections.js';
import { REVIEW_GATES, isReviewGate, type ReviewGate } from '../../cards/models/review.js';
import { describeDataStoreError } from '../../cards/cli/data-store-messages.js';
import type { OrderRef } from '../../cards/usecases/commands/move-in-order.js';
import type { Result } from '../../shared/result.js';
import type { BoardCard } from '../models/board-card.js';
import type { DecideError, DecideRefusal } from '../errors/board-errors.js';
import type { DecideCommands, Decided } from '../usecases/commands/decide.command.js';
import { describeForge } from './status-describe.js';

// ============================================================
// ai-board decide — 人がチャットで頼んだ判断を書くための CLI
// ============================================================

/**
 * 人の判断（承認 / 差し戻し / 中止、着手 / 着手を戻す、飛ばす宣言、並べ替え）を書く。
 *
 * 段取り（ボードの導出・検査・書き込み・コミットのメッセージ・書いた後の列）は usecase（`decide.command.ts`）が持つ。
 * この CLI は、引数の形を確かめて usecase を呼び、結果とエラーを人に読める 1 行に直すだけにする。
 *
 * 誰が使ってよいかは構造では分けない。人と、人がこの会話で自分の言葉で頼んだ Claude（`board-decide` のスキル）が使い、
 * `board-reviewer` とループの周の中では使わない。この境界は手順書の決まりで守る（ADR 0007）。
 * AI が書いてよいもの（本文・ブランチ・提出 / 再提出 / 保留）は `ai-board card` にあり、ここには入れない。
 */
export const DECIDE_USAGE = `使い方: ai-board decide <command> [--root <path>]

人の判断を書く。人と、人がこの会話で自分の言葉で頼んだ Claude（board-decide）だけが使う。
board-reviewer とループの周の中では使わない。出せない判断は拒む。

Commands:
  approve <id> [--reason <text>]   plan を承認する
  reject <id> --reason <text>      plan を差し戻す（理由は必須）
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
  /** 人の判断を書く usecase。ボードの導出・検査・書き込みを書き込みの 1 操作の中で走らせる */
  readonly decide: DecideCommands;
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
  reject: {
    run: (a, d, io) => runReview('差し戻し', a, d, io),
    flags: ['--reason'],
    positionals: 1,
  },
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
// 承認 / 差し戻し / 中止
// ============================================================

async function runReview(
  kind: '承認' | '差し戻し' | '中止',
  args: ParsedArgs,
  deps: DecideCliDependencies,
  io: DecideCliIo
): Promise<number> {
  const id = requireCardId(args, io);
  if (id === null) return 1;

  const reasonFlag = args.flags.get('--reason');
  const reason = typeof reasonFlag === 'string' ? reasonFlag.trim() : '';

  const result = await deps.decide.review({ id, kind, reason, at: io.now() });
  return reportWrite(result, io);
}

// ============================================================
// 着手 / 着手を戻す / 飛ばす宣言
// ============================================================

async function runStart(
  args: ParsedArgs,
  deps: DecideCliDependencies,
  io: DecideCliIo
): Promise<number> {
  const id = requireCardId(args, io);
  if (id === null) return 1;

  return reportWrite(await deps.decide.start({ id, at: io.now() }), io);
}

async function runUnstart(
  args: ParsedArgs,
  deps: DecideCliDependencies,
  io: DecideCliIo
): Promise<number> {
  const id = requireCardId(args, io);
  if (id === null) return 1;

  return reportWrite(await deps.decide.unstart({ id }), io);
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

  return reportWrite(await deps.decide.skip({ id, gate, remove }), io);
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

  const result = await deps.decide.move({
    id,
    after: after as OrderRef | null,
    before: before as OrderRef | null,
  });

  if (!result.ok) return fail(io, describeDecideError(result.error));
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

  const result = await deps.decide.moveDivider({
    after: after as CardId | null,
    before: before as CardId | null,
  });

  if (!result.ok) return fail(io, describeDecideError(result.error));
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

function requireCardId(args: ParsedArgs, io: DecideCliIo): CardId | null {
  const parsed = CardIdSchema.safeParse(args.positionals[0]);
  if (!parsed.success) {
    io.stderr('カード ID（kebab-case）を指定してください\n');
    return null;
  }
  return parsed.data as CardId;
}

/**
 * 列を確かめて拒んだ操作の名前。`StageMismatch` を返すのは着手（アイデアから）と着手を戻す（計画提案中から）だけ
 */
function startedAtLabel(from: Stage): string {
  return from === 'idea' ? '着手' : '着手を戻す';
}

/**
 * 判断を書けない理由の 1 行。
 *
 * GitHub に繋がらないときは、PR の状態が引けないと計画レビューのカードが手前の列に落ちて見え、
 * 出せる判断や戻せる列を取り違えるので拒む（`status` が `next` を `null` にするのと同じ理由）。
 */
function describeRefusal(refusal: DecideRefusal): string {
  switch (refusal.type) {
    case 'ForgeUnavailable': {
      const what = refusal.action === 'review' ? '承認 / 差し戻し / 中止' : '着手 / 着手を戻す';
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
        `${refusal.id} は${startedAtLabel(refusal.from)}できません（今の列: ${STAGE_LABELS[refusal.card.stage]}。` +
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
 * 書いた結果を出す。成功なら、usecase が書いた後のボードで読んだ列の移りを 1 行で出す
 * （`board-decide` はこの行を人に伝える）。
 */
function reportWrite(result: Result<Decided, DecideError>, io: DecideCliIo): number {
  if (!result.ok) return fail(io, describeDecideError(result.error));
  const { id, what, from, to } = result.value;

  const transition =
    to === null
      ? '書いた後の列は読めませんでした'
      : to === from
        ? STAGE_LABELS[to]
        : `${STAGE_LABELS[from]} → ${STAGE_LABELS[to]}`;

  io.stdout(`${id}: ${what} を書きました（${transition}）\n`);
  return 0;
}

function describeDecideError(error: DecideError): string {
  switch (error.type) {
    case 'BoardUnreadable':
      return `ボードを読めませんでした: ${error.reason}`;
    case 'CardNotFound':
      return `カードが見つかりません: ${error.id}`;
    case 'StaleOrder':
      return `--after（${error.after}）と --before（${error.before}）の並びが今の表と逆です。status で並びを読み直してください`;
    case 'CardWriteRefused':
      return `カードのファイルへの書き込みを拒みました（${error.reason}）`;
    case 'ForgeUnavailable':
    case 'DecisionUnavailable':
    case 'ReasonRequired':
    case 'StageMismatch':
    case 'CardAborted':
    case 'NotInIdeaTable':
      return describeRefusal(error);
    default:
      // 残りは DataStoreError。describeDataStoreError の switch が種別を網羅する
      return describeDataStoreError(error);
  }
}

function fail(io: DecideCliIo, message: string): number {
  io.stderr(`${message}\n`);
  return 1;
}
