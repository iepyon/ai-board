import type { CardCliIo } from '../../cards/cli/card-cli.js';
import {
  decisionsFor,
  groupBySection,
  ideaRows,
  isStale,
  type Decision,
} from '../../shared/dashboard-sections.js';
import { STAGE_LABELS } from '../../shared/stage-labels.js';
import type { Stage } from '../../shared/schemas/common.js';
import type { GetBoardQuery } from '../usecases/queries/get-board.query.js';
import type { Board, BoardCard } from '../models/board-card.js';
import type { ForgeConnection } from '../models/mr-state.js';
import { pickNextAction, type NextAction } from '../services/next-action.js';
import { resolveImplStep, type ImplStep } from '../services/impl-step.js';
import type { BranchPlanRepository } from '../repositories/branch-plan.repository.js';
import { createCardId } from '../../shared/schemas/common.js';
import { describeForge, describeLoop, describeNext, describeStuck } from './status-describe.js';
import { isCardRunning, type BoardLoop } from '../../shared/loop-activity.js';

// ============================================================
// ai-board status — ボードの状態を読む
// ============================================================

/**
 * `StatusReport` の最上位の項目と、配列かどうか。`--only` の打ち間違いを、出す前に見分けるのに使う。
 * `satisfies` で `StatusReport` の項目と食い違えば型検査で落ちる
 */
const STATUS_KEY_KINDS = {
  next: 'value',
  waiting: 'array',
  working: 'array',
  cards: 'array',
  ideas: 'array',
  forge: 'value',
  loop: 'value',
  generatedAt: 'value',
} as const satisfies Record<keyof StatusReport, 'value' | 'array'>;

const STATUS_KEYS = Object.keys(STATUS_KEY_KINDS) as (keyof StatusReport)[];

function isStatusKey(key: string): key is keyof StatusReport {
  return Object.hasOwn(STATUS_KEY_KINDS, key);
}

export const STATUS_USAGE = `使い方: ai-board status [--json [--only <項目,...>]] [--root <path>]

ボードの状態（導出したステージ、判断待ち、次の一手）を出します。サーバは要りません。
  --json   機械向けの JSON で出す（AI ループはこちらを読む）
  --only <項目,...>
           --json の出力を、コンマ区切りの項目だけに絞る。項目は <key>（最上位の項目）か
           <key>.<field>（最上位の配列の各要素から <field> だけ）。例: --only next,waiting,cards.id
           最上位の項目: ${STATUS_KEYS.join(', ')}
`;

interface CardSummary {
  readonly id: string;
  readonly title: string;
  readonly stage: Stage;
  readonly reason: string;
  /** ループが今このカードを触っているか（終わっていない 1 手の記録がある） */
  readonly running: boolean;
}

/**
 * 人の番のカード。判断を待つ列（計画レビュー / PR中）のカードと、
 * AI の列で止まっているカード（`hold`。ループはこれを選ばない）。
 * `decisions` は `ai-board decide` が受け付ける判断と同じもの（`decisionsFor`）。PR中 のカードは空
 */
export interface WaitingCard extends CardSummary {
  readonly decisions: readonly Decision[];
}

export type StatusCard = Omit<BoardCard, 'body'>;

/** AI が進めているカード。`stale` はしばらく動きが無いもの */
export interface WorkingCard extends CardSummary {
  readonly stale: boolean;
}

/** アイデアの表の 1 行。`ideaRows` と同じ順で、区切り線も 1 行として入る */
export type IdeaListRow =
  { readonly id: string; readonly title: string } | { readonly divider: true };

export interface StatusReport {
  /** ループが次に進めるもの。無いか、GitHub につながっていなければ null */
  readonly next: NextAction | null;
  readonly waiting: readonly WaitingCard[];
  readonly working: readonly WorkingCard[];
  readonly cards: readonly StatusCard[];
  readonly ideas: readonly IdeaListRow[];
  readonly forge: ForgeConnection;
  /** ループの様子（今触っている手と、最後に手を終えた時刻）。各カードの手の一覧は `cards[].loopSteps` */
  readonly loop: BoardLoop;
  readonly generatedAt: string;
}

export interface StatusDependencies {
  readonly getBoardQuery: GetBoardQuery;
  /**
   * カードのブランチの計画を読む。`next.action` が `implement` のときだけ使い、`next.step` を埋める。
   * 省略時は段を読まず、`next.step` は null のまま
   */
  readonly branchPlanRepository?: BranchPlanRepository;
}

/** 出す形。`text` は人向けの数行 */
export type StatusFormat = 'text' | 'json';

export type StatusArgs =
  | {
      readonly format: StatusFormat;
      readonly only?: readonly StatusField[];
    }
  | 'help'
  | 'invalid';

/**
 * `--only` の 1 項目。`field` が null なら最上位の項目をそのまま出し、
 * 文字列なら最上位の配列の各要素から `field` だけを出す
 */
export interface StatusField {
  readonly key: keyof StatusReport;
  readonly field: string | null;
}

/**
 * 引数を解釈する。DB を開いたり GitHub に問い合わせたりする前に呼ぶ
 * （`--help` や打ち間違いで PR 番号の書き戻しを起こさないため）。
 */
export function parseStatusArgs(argv: readonly string[]): StatusArgs {
  if (argv.includes('--help') || argv.includes('-h')) return 'help';

  const scanned = scanStatusArgs(argv);
  if (scanned === null) return 'invalid';

  const format = pickFormat(scanned);
  if (format === null) return 'invalid';

  const { only } = scanned;
  return { format, ...(only === null ? {} : { only }) };
}

/** 出す形を決める。絞り込みは JSON にだけ効く。組み合わせが誤っていれば null */
function pickFormat({ json, only }: ScannedStatusArgs): StatusFormat | null {
  if (only !== null && !json) return null;

  return json ? 'json' : 'text';
}

interface ScannedStatusArgs {
  json: boolean;
  only: readonly StatusField[] | null;
}

/** 引数を 1 つずつ読む。不明な引数や、2 回目の `--only`、`--only` の値の誤りは null */
function scanStatusArgs(argv: readonly string[]): ScannedStatusArgs | null {
  const scanned: ScannedStatusArgs = { json: false, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') scanned.json = true;
    else if (arg === '--only' && scanned.only === null) {
      scanned.only = parseOnly(argv[++i]);
      if (scanned.only === null) return null;
    } else return null;
  }
  return scanned;
}

/**
 * `--only` の値を解釈する。誤り（値が無い、無い最上位の項目、配列でない項目への `.`、2 段以上の `.`）は null。
 * 打ち間違いを黙って空の出力にしないため、出す前に失敗させる
 */
function parseOnly(value: string | undefined): readonly StatusField[] | null {
  if (value === undefined || value.startsWith('--')) return null;

  const fields: StatusField[] = [];
  for (const item of value.split(',')) {
    const [key, field, ...deeper] = item.split('.');
    if (key === undefined || !isStatusKey(key) || deeper.length > 0) return null;
    if (field === undefined) {
      fields.push({ key, field: null });
      continue;
    }
    if (field === '' || STATUS_KEY_KINDS[key] !== 'array') return null;
    fields.push({ key, field });
  }
  return fields;
}

/**
 * 出力を `fields` の項目だけに絞る。最上位の項目は `fields` に初めて出た順に並べる。
 *
 * 同じ最上位の項目を丸ごとと `.<field>` の両方で指したら、丸ごと出す。
 * 要素に無い `<field>` は、その要素では出さない（カードによって無い項目があるため）。
 */
export function pickFields(
  report: StatusReport,
  fields: readonly StatusField[]
): Record<string, unknown> {
  const wanted = new Map<keyof StatusReport, Set<string> | 'whole'>();
  for (const { key, field } of fields) {
    const current = wanted.get(key);
    if (field === null || current === 'whole') {
      wanted.set(key, 'whole');
    } else {
      wanted.set(key, (current ?? new Set<string>()).add(field));
    }
  }

  const picked: Record<string, unknown> = {};
  for (const [key, want] of wanted) {
    const value = report[key];
    picked[key] =
      want === 'whole' || !Array.isArray(value)
        ? value
        : value.map((element: object) =>
            Object.fromEntries(Object.entries(element).filter(([name]) => want.has(name)))
          );
  }
  return picked;
}

/** `ai-board status` を実行し、終了コードを返す */
export async function runStatusCli(
  argv: readonly string[],
  deps: StatusDependencies,
  io: Pick<CardCliIo, 'stdout' | 'stderr' | 'now'>
): Promise<number> {
  const args = parseStatusArgs(argv);
  if (typeof args === 'string') {
    io.stderr(STATUS_USAGE);
    return args === 'help' ? 0 : 1;
  }

  const result = await deps.getBoardQuery();
  if (!result.ok) {
    io.stderr(`ボードを読めませんでした: ${result.error.reason}\n`);
    return 1;
  }

  const built = buildStatusReport(result.value, io.now());
  const report = await withImplStep(built, deps.branchPlanRepository);

  io.stdout(
    args.only === undefined
      ? formatReport(report, args.format)
      : `${JSON.stringify(pickFields(report, args.only), null, 2)}\n`
  );
  return 0;
}

/**
 * `next.action` が `implement` のときだけ、カードのブランチの計画を読んで `next.step` を埋める。
 *
 * 読むのは `next` に選ばれた 1 枚だけ。ステージの導出には持ち込まない。
 * 読めない（読み手が無い、`branch` が null、ブランチや計画が無い）ときは `step: null` のままにし、
 * `status` は失敗させない（次の一手そのものは読めているため）。
 */
async function withImplStep(
  report: StatusReport,
  reader: BranchPlanRepository | undefined
): Promise<StatusReport> {
  const next = report.next;
  if (next === null || next.action !== 'implement' || reader === undefined) return report;

  const step = await readImplStep(next.cardId, report.cards, reader);
  return { ...report, next: { ...next, step } };
}

async function readImplStep(
  cardId: string,
  cards: readonly StatusCard[],
  reader: BranchPlanRepository
): Promise<ImplStep | null> {
  const branch = cards.find((card) => card.id === cardId)?.branch ?? null;
  if (branch === null) return null;

  const plan = await reader.find(createCardId(cardId), branch);
  return plan === null ? null : resolveImplStep(plan);
}

function formatReport(report: StatusReport, format: StatusFormat): string {
  switch (format) {
    case 'json':
      return `${JSON.stringify(report, null, 2)}\n`;
    case 'text':
      return formatStatus(report);
  }
}

/**
 * ボードから、ループと人が読むための要約を組み立てる。
 *
 * GitHub につながっていないときは次の一手を出さない。PR の状態が引けないと、
 * 計画レビュー / PR中 のカードが手前の AI の列に落ちて見え、人を待つカードを進めてしまうため。
 * `github:` の無いリポジトリでも同じで、ループは `gh` で PR を出すので GitHub を前提にする。
 */
export function buildStatusReport(board: Board, now: Date): StatusReport {
  const cards = board.cards.map(({ body: _body, ...rest }) => rest);
  // 判断待ちの区画の振り分け。止まっているカードは inbox に入り、work には入らない
  const sections = groupBySection(cards);

  return {
    next: board.forge.status === 'connected' ? pickNextAction(cards) : null,
    waiting: sections.inbox.map((card) => ({
      ...toSummary(card, board.loop),
      decisions: decisionsFor(card),
    })),
    working: sections.work.map((card) => ({
      ...toSummary(card, board.loop),
      stale: isStale(card, now),
    })),
    cards,
    ideas: ideaRows(sections.idea, board.ideaDivider).map((row) =>
      row.kind === 'card' ? { id: row.card.id, title: row.card.title } : { divider: true }
    ),
    forge: board.forge,
    loop: board.loop,
    generatedAt: board.generatedAt,
  };
}

/** 人向けの数行。判断待ち / AI 作業中 / 次の一手 の順に並べる */
export function formatStatus(report: StatusReport): string {
  const lines = [`GitHub: ${describeForge(report.forge)}`, describeLoop(report), ''];

  lines.push(`判断待ち (${report.waiting.length})`);
  for (const card of report.waiting) {
    lines.push(`  ${card.id}  [${STAGE_LABELS[card.stage]}]  ${card.title}${runningMark(card)}`);
    lines.push(`    ${card.reason}`);
  }

  lines.push('', `AI 作業中 (${report.working.length})`);
  for (const card of report.working) {
    const stale = card.stale ? '  ※ 動きなし' : '';
    lines.push(
      `  ${card.id}  [${STAGE_LABELS[card.stage]}]  ${card.title}${runningMark(card)}${stale}`
    );
  }

  const nextCard = report.cards.find((card) => card.id === report.next?.cardId);
  const stuck = nextCard === undefined ? null : describeStuck(nextCard.loopSteps);
  lines.push(
    '',
    `次の一手: ${describeNext(report.next, report.forge)}${stuck === null ? '' : `  ※ ${stuck}`}`
  );

  return `${lines.join('\n')}\n`;
}

function runningMark(card: CardSummary): string {
  return card.running ? '  ※ AI 稼働中' : '';
}

/** 止まっているカードは、ステージの理由ではなく人が何をすればよいか（`hold.reason`）を出す */
function toSummary(card: StatusCard, loop: BoardLoop): CardSummary {
  return {
    id: card.id,
    title: card.title,
    stage: card.stage,
    reason: card.hold?.reason ?? card.reason,
    running: isCardRunning(loop, card.id),
  };
}
