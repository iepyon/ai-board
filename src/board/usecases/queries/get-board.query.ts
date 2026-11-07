import { ok, err, type Result } from '../../../shared/result.js';
import type { CardRepository } from '../../../cards/repositories/card.repository.js';
import type { IdeaDividerRepository } from '../../../cards/repositories/idea-divider.repository.js';
import type { PlanRepository } from '../../repositories/plan.repository.js';
import type { PrStateProvider } from '../../services/pr-state-provider.js';
import {
  droppableStages,
  hasFixAfterReview,
  resolveFloorStage,
  resolveStage,
} from '../../services/stage-resolver.js';
import { latestGateEntry, parseReviewLog } from '../../../cards/services/review-log.js';
import { resolveHold, type HoldInput } from '../../services/next-action.js';
import type { LoopHistoryRepository } from '../../repositories/loop-history.repository.js';
import type { LoopStep } from '../../../shared/loop-step.js';
import { toBoardLoop } from '../../../shared/loop-activity.js';
import type { ReviewEntry } from '../../../cards/models/review.js';
import type { Stage } from '../../../shared/schemas/common.js';
import { GATE_OF_STAGE } from '../../../shared/stage-gates.js';
import { awaitsPrFix } from '../../../shared/pr-feedback.js';
import {
  toBoardCard,
  toBoardCardReview,
  type Board,
  type BoardCard,
  type BoardCardPr,
  type BoardCardPlan,
  type BoardCardReview,
} from '../../models/board-card.js';
import type { PlanDoc, PlanState } from '../../models/plan-state.js';
import type { Card } from '../../../cards/models/card.js';
import {
  emptyBranchPlanRepository,
  type BranchPlanRepository,
} from '../../repositories/branch-plan.repository.js';
import { branchCloseTarget, branchPlanTarget } from '../../services/branch-plan-target.js';
import { isForgeUnset, type PrState } from '../../models/pr-state.js';
import type { GetBoardError } from '../../errors/board-errors.js';

// ============================================================
// ボード取得ユースケース
// ============================================================

export type GetBoardQuery = () => Promise<Result<Board, GetBoardError>>;

/**
 * カード・計画ファイル・レビュー要求の 3 ソースを束ねてボードを組み立てる。
 *
 * ステージ導出そのものは `resolveStage`（純関数）に委譲し、
 * ここは I/O と組み立てだけを担当する。
 * GitHub が未設定のボードでは、メインに計画の無いカードのブランチの計画を `branchPlanRepository` で補う（`branchPlanTarget`）。
 * 同じく、実装中のカードの締めが済んだか（ブランチで計画が archive 済みか）を読み、マージ待ちの止まりにだけ使う（`branchCloseTarget`）。
 * ループの 1 手の記録は、ループの様子（`Board.loop`）とカードの手の一覧にだけ使い、
 * ステージの導出と止まりには渡さない。
 */
export function createGetBoardQuery(
  cardRepository: CardRepository,
  ideaDividerRepository: IdeaDividerRepository,
  planRepository: PlanRepository,
  prProvider: PrStateProvider,
  loopHistoryRepository: LoopHistoryRepository,
  branchPlanRepository: BranchPlanRepository = emptyBranchPlanRepository
): GetBoardQuery {
  return async () => {
    let cards;
    let planState;
    let ideaDivider;
    let loopSteps;

    try {
      [cards, planState, ideaDivider, loopSteps] = await Promise.all([
        cardRepository.findAll(),
        planRepository.load(),
        ideaDividerRepository.get(),
        loopHistoryRepository.findAll(),
      ]);
    } catch (error) {
      return err({
        type: 'BoardUnreadable',
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const forge = prProvider.connection();
    const forgeUnset = isForgeUnset(forge);
    const closedByCard = forgeUnset
      ? await closedBranches(planState, cards, branchPlanRepository)
      : new Map<string, BranchClosedHold>();
    const closedOf = (cardId: string): BranchClosedHold | null => closedByCard.get(cardId) ?? null;
    if (forgeUnset) planState = await withBranchPlans(planState, cards, branchPlanRepository);
    const prKnown = forge.status === 'connected' && prProvider.synced();
    const generatedAt = new Date().toISOString();
    const stepsByCard = groupByCard(loopSteps);

    const boardCards: BoardCard[] = cards.map((card) => {
      const plan = planState.get(card.id) ?? null;
      const pr = prProvider.get(card.id);
      const prFailure = prProvider.failure(card.id);
      const unsetPr = forgeUnset ? unsetPrOf(card.pr, generatedAt) : null;
      // PR の状態を信じられない（引けない・未設定で PR 番号を持つ）カード。止まりにし、どの列へも動かさせない
      const prUntrusted = prFailure !== null || unsetPr !== null;

      const resolution = resolveStage(card, plan, pr);
      const floorStage = resolveFloorStage(card, plan, pr);
      const entries = parseReviewLog(card.body);

      return toBoardCard(
        card,
        entries,
        resolution,
        // 列が控えに依るか分からないので、どの列へも動かさせない（`ai-board decide` が従う）
        { floorStage, droppableStages: prUntrusted ? [] : droppableStages(floorStage) },
        latestReview(entries, resolution.stage),
        toBoardCardPlan(plan),
        toBoardCardPr(pr),
        resolveHold({
          ...resolution,
          entries,
          pr,
          prKnown,
          prFailure,
          unsetPr,
          branchClosed: closedOf(card.id),
        }),
        stepsByCard.get(card.id) ?? []
      );
    });

    return ok({
      cards: boardCards,
      forge,
      ideaDivider,
      loop: toBoardLoop(loopSteps),
      generatedAt,
    });
  };
}

/** メインのチェックアウトに無い計画を、`branchPlanTarget` が選んだカードのブランチの計画でまとめて補う。読めなければ補わない */
async function withBranchPlans(
  planState: PlanState,
  cards: readonly Card[],
  reader: BranchPlanRepository
): Promise<PlanState> {
  const found = await Promise.all(
    cards.map((card) => {
      const branch = branchPlanTarget(card, planState.get(card.id) ?? null);
      return branch === null ? null : reader.findActive(card.id, branch);
    })
  );
  const merged = new Map(planState);
  for (const doc of found) {
    if (doc !== null) merged.set(doc.cardId, doc);
  }
  return merged;
}

type BranchClosedHold = NonNullable<HoldInput['branchClosed']>;

/**
 * `branchCloseTarget` が選んだカードについて、締めが済んだ（ブランチで計画が archive 済み）ものを、カード ID ごとにまとめて読む。
 * メインの計画だけで選ぶので、ブランチの計画で補う前の `planState` を渡す
 */
async function closedBranches(
  planState: PlanState,
  cards: readonly Card[],
  reader: BranchPlanRepository
): Promise<Map<string, BranchClosedHold>> {
  const found = await Promise.all(
    cards.map(async (card): Promise<[string, BranchClosedHold] | null> => {
      const branch = branchCloseTarget(card, planState.get(card.id) ?? null);
      if (branch === null) return null;
      const closed = await reader.findClosed(card.id, branch);
      return closed === null ? null : [card.id, { branch, since: closed.archivedAt }];
    })
  );
  return new Map(found.filter((entry) => entry !== null));
}

/**
 * 未設定のボードで PR 番号を持つカードの、その番号と止まりの起点。番号が無ければ null。
 * PR の状態を引けないカードと同じに止める（`resolveHold`）
 */
function unsetPrOf(pr: number | null, since: string): HoldInput['unsetPr'] {
  return pr === null ? null : { number: pr, since };
}

/** 記録をカードごとに分ける。並び（開始の時刻の順）は保つ */
function groupByCard(steps: readonly LoopStep[]): Map<string, LoopStep[]> {
  const byCard = new Map<string, LoopStep[]>();
  for (const step of steps) {
    const list = byCard.get(step.cardId);
    if (list === undefined) byCard.set(step.cardId, [step]);
    else list.push(step);
  }
  return byCard;
}

function toBoardCardPlan(plan: PlanDoc | null): BoardCardPlan | null {
  if (plan === null) return null;

  return { tasks: plan.tasks, archived: plan.archived, updatedAt: plan.updatedAt };
}

/** その列が待っているゲートの最新エントリ。待ちの列でなければゲートを問わず最新 */
function latestReview(entries: readonly ReviewEntry[], stage: Stage): BoardCardReview | null {
  const entry = latestGateEntry(entries, GATE_OF_STAGE[stage]);
  if (entry === null) return null;

  return toBoardCardReview(entry);
}

function toBoardCardPr(pr: PrState | null): BoardCardPr | null {
  if (pr === null) return null;

  return {
    forge: pr.forge,
    number: pr.number,
    state: pr.state,
    draft: pr.draft,
    title: pr.title,
    webUrl: pr.webUrl,
    noteCount: pr.noteCount,
    latestNoteAt: pr.latestNoteAt,
    latestAiNoteAt: pr.latestAiNoteAt,
    latestCommitAt: pr.latestCommitAt,
    resubmitted: hasFixAfterReview(pr),
    awaitingFix: awaitsPrFix(pr),
    mergedAt: pr.mergedAt,
    readyAt: pr.readyAt,
    convertedToDraftAt: pr.convertedToDraftAt,
  };
}
