import { ok, type Result } from '../../../shared/result.js';
import { createCardId } from '../../../shared/schemas/common.js';
import { decisionsFor, groupBySection, ideaRows, isStale } from '../../../shared/board-sections.js';
import { isCardRunning, type BoardLoop } from '../../../shared/loop-activity.js';
import type { Board } from '../../models/board-card.js';
import { forgeTrusted } from '../../models/pr-state.js';
import type { CardSummary, StatusCard, StatusReport } from '../../models/status-report.js';
import type { GetBoardError } from '../../errors/board-errors.js';
import { pickNextAction } from '../../services/next-action.js';
import { resolveImplStep, type ImplStep } from '../../services/impl-step.js';
import type { BranchPlanRepository } from '../../repositories/branch-plan.repository.js';
import type { GetBoardQuery } from './get-board.query.js';

// ============================================================
// ボードの見せる形の取得 — 判断待ち・作業中・アイデアの表・次の一手
// ============================================================

/** `now` は「しばらく動きが無い」（`stale`）を決める今の時刻 */
export type GetStatusQuery = (now: Date) => Promise<Result<StatusReport, GetBoardError>>;

/**
 * ボードを読み、ループと人が読むための形（`StatusReport`）を組む。
 *
 * `branchPlanRepository` はカードのブランチの計画を読む。`next.action` が `implement` のときだけ使い、`next.step` を埋める。
 * 省略時は段を読まず、`next.step` は null のまま。
 */
export function createGetStatusQuery(
  getBoardQuery: GetBoardQuery,
  branchPlanRepository?: BranchPlanRepository
): GetStatusQuery {
  return async (now) => {
    const board = await getBoardQuery();
    if (!board.ok) return board;

    return ok(await withImplStep(buildStatusReport(board.value, now), branchPlanRepository));
  };
}

/**
 * ボードから、ループと人が読むための要約を組み立てる。
 *
 * GitHub が接続済みか未設定（`forgeTrusted`）でなければ次の一手を出さない。PR の状態が引けないと、
 * 計画レビュー / PR中 のカードが手前の AI の列に落ちて見え、人を待つカードを進めてしまうため。
 * 未設定のボードを通す理由は `forgeTrusted` にある。
 */
function buildStatusReport(board: Board, now: Date): StatusReport {
  const cards = board.cards.map(({ body: _body, ...rest }) => rest);
  // 判断待ちの区画の振り分け。止まっているカードは inbox に入り、work には入らない
  const sections = groupBySection(cards);

  return {
    next: forgeTrusted(board.forge) ? pickNextAction(cards) : null,
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

/**
 * `next.action` が `implement` のときだけ、カードのブランチの計画を読んで `next.step` を埋める。
 *
 * 読むのは `next` に選ばれた 1 枚だけ。ステージの導出には持ち込まない。
 * 読めない（読み手が無い、`branch` が null、ブランチや計画が無い）ときは `step: null` のままにし、
 * 失敗させない（次の一手そのものは読めているため）。
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
