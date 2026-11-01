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
import type { ServerLocation } from '../../infrastructure/server-info.js';
import { pickNextAction, type NextAction } from '../services/next-action.js';
import { resolveImplStep, type ImplStep } from '../services/impl-step.js';
import type { BranchPlanRepository } from '../repositories/branch-plan.repository.js';
import { createCardId } from '../../shared/schemas/common.js';
import { describeForge, describeNext } from './status-describe.js';
import { formatStatusHtml } from './status-html.js';

// ============================================================
// ai-board status — サーバを起動せずにボードの状態を読む
// ============================================================

export const STATUS_USAGE = `使い方: ai-board status [--json | --html] [--root <path>]

ボードの状態（導出したステージ、判断待ち、次の一手）を出します。サーバは要りません。
  --json   機械向けの JSON で出す（AI ループはこちらを読む）
  --html   ボードを 1 枚の自己完結の HTML で出す（Artifact として公開して読む）
`;

interface CardSummary {
  readonly id: string;
  readonly title: string;
  readonly stage: Stage;
  readonly reason: string;
}

/**
 * 人の番のカード。判断を待つ列（計画レビュー / 動作確認 / PR中）のカードと、
 * AI の列で止まっているカード（`hold`。ループはこれを選ばない）。
 * `decisions` は画面がボタンとして出す判断と同じもの（`decisionsFor`）。PR中 のカードは空
 */
export interface WaitingCard extends CardSummary {
  readonly decisions: readonly Decision[];
}

export type StatusCard = Omit<BoardCard, 'body'>;

/** AI が進めているカード。`stale` はしばらく動きが無いもの */
export interface WorkingCard extends CardSummary {
  readonly stale: boolean;
}

/** アイデアの表の 1 行。画面の並び（`ideaRows`）と同じ順で、区切り線も 1 行として入る */
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
  /** 同じ DB を使って起動中のサーバ。人の API を叩くとき（`board-decide`）に使う。無ければ null */
  readonly server: ServerLocation | null;
  readonly generatedAt: string;
}

export interface StatusDependencies {
  readonly getBoardQuery: GetBoardQuery;
  /** 起動中のサーバを探す。省略時は null（サーバは無いものとする） */
  readonly findServer?: () => ServerLocation | null;
  /**
   * カードのブランチの計画を読む。`next.action` が `implement` のときだけ使い、`next.step` を埋める。
   * 省略時は段を読まず、`next.step` は null のまま
   */
  readonly branchPlanRepository?: BranchPlanRepository;
}

/** 出す形。`text` は人向けの数行 */
export type StatusFormat = 'text' | 'json' | 'html';

export type StatusArgs = { readonly format: StatusFormat } | 'help' | 'invalid';

/**
 * 引数を解釈する。DB を開いたり GitHub に問い合わせたりする前に呼ぶ
 * （`--help` や打ち間違いで PR 番号の書き戻しを起こさないため）。
 */
export function parseStatusArgs(argv: readonly string[]): StatusArgs {
  if (argv.includes('--help') || argv.includes('-h')) return 'help';
  if (argv.some((arg) => arg !== '--json' && arg !== '--html')) return 'invalid';

  const json = argv.includes('--json');
  const html = argv.includes('--html');
  // 2 つの形を同時には出せない
  if (json && html) return 'invalid';

  return { format: json ? 'json' : html ? 'html' : 'text' };
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

  const built = buildStatusReport(result.value, io.now(), deps.findServer?.() ?? null);
  const report = await withImplStep(built, deps.branchPlanRepository);

  io.stdout(formatReport(report, args.format));
  return 0;
}

/**
 * `next.action` が `implement` のときだけ、カードのブランチの計画を読んで `next.step` を埋める。
 *
 * 読むのは `next` に選ばれた 1 枚だけ。サーバとステージの導出には持ち込まない。
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
    case 'html':
      return formatStatusHtml(report);
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
export function buildStatusReport(
  board: Board,
  now: Date,
  server: ServerLocation | null = null
): StatusReport {
  const cards = board.cards.map(({ body: _body, ...rest }) => rest);
  // 画面の判断待ちの区画と同じ振り分け。止まっているカードは inbox に入り、work には入らない
  const sections = groupBySection(cards);

  return {
    next: board.forge.status === 'connected' ? pickNextAction(cards) : null,
    waiting: sections.inbox.map((card) => ({ ...toSummary(card), decisions: decisionsFor(card) })),
    working: sections.work.map((card) => ({ ...toSummary(card), stale: isStale(card, now) })),
    cards,
    ideas: ideaRows(sections.idea, board.ideaDivider).map((row) =>
      row.kind === 'card' ? { id: row.card.id, title: row.card.title } : { divider: true }
    ),
    forge: board.forge,
    server,
    generatedAt: board.generatedAt,
  };
}

/** 人向けの数行。判断待ち / AI 作業中 / 次の一手 の順に並べる */
export function formatStatus(report: StatusReport): string {
  const lines = [
    `GitHub: ${describeForge(report.forge)}`,
    `サーバ: ${report.server?.url ?? '起動していません'}`,
    '',
  ];

  lines.push(`判断待ち (${report.waiting.length})`);
  for (const card of report.waiting) {
    lines.push(`  ${card.id}  [${STAGE_LABELS[card.stage]}]  ${card.title}`);
    lines.push(`    ${card.reason}`);
  }

  lines.push('', `AI 作業中 (${report.working.length})`);
  for (const card of report.working) {
    const stale = card.stale ? '  ※ 動きなし' : '';
    lines.push(`  ${card.id}  [${STAGE_LABELS[card.stage]}]  ${card.title}${stale}`);
  }

  lines.push('', `次の一手: ${describeNext(report.next, report.forge)}`);

  return `${lines.join('\n')}\n`;
}

/** 止まっているカードは、ステージの理由ではなく人が何をすればよいか（`hold.reason`）を出す */
function toSummary(card: StatusCard): CardSummary {
  return {
    id: card.id,
    title: card.title,
    stage: card.stage,
    reason: card.hold?.reason ?? card.reason,
  };
}
