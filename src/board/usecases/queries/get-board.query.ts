import { ok, err, type Result } from '../../../shared/result.js';
import type { CardRepository } from '../../../cards/repositories/card.repository.js';
import type { IdeaDividerRepository } from '../../../cards/repositories/idea-divider.repository.js';
import type { PlanRepository } from '../../repositories/plan.repository.js';
import type { MrStateProvider } from '../../services/mr-state-provider.js';
import {
  droppableStages,
  hasFixAfterReview,
  resolveFloorStage,
  resolveStage,
} from '../../services/stage-resolver.js';
import { latestGateEntry, parseReviewLog } from '../../../cards/services/review-log.js';
import { resolveHold } from '../../services/next-action.js';
import { resolveTimeline } from '../../services/stage-timeline.js';
import { splitAiPhases } from '../../services/timeline-phases.js';
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
  type BoardCardMr,
  type BoardCardPlan,
  type BoardCardReview,
} from '../../models/board-card.js';
import type { PlanDoc } from '../../models/plan-state.js';
import type { MrState } from '../../models/mr-state.js';
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
 * ループの 1 手の記録は、ループの様子（`Board.loop`）・カードの手の一覧・区間の小区間にだけ使い、
 * ステージの導出と止まりには渡さない。
 */
export function createGetBoardQuery(
  cardRepository: CardRepository,
  ideaDividerRepository: IdeaDividerRepository,
  planRepository: PlanRepository,
  mrProvider: MrStateProvider,
  loopHistoryRepository: LoopHistoryRepository
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

    const cardIds = new Set<string>(cards.map((card) => card.id));
    const forge = mrProvider.connection();
    const mrKnown = forge.status === 'connected' && mrProvider.synced();
    const stepsByCard = groupByCard(loopSteps);

    const boardCards: BoardCard[] = cards.map((card) => {
      const plan = planState.get(card.id) ?? null;
      const mr = mrProvider.get(card.id);
      const mrFailure = mrProvider.failure(card.id);

      const resolution = resolveStage(card, plan, mr);
      const floorStage = resolveFloorStage(card, plan, mr);
      const entries = parseReviewLog(card.body);
      const steps = stepsByCard.get(card.id) ?? [];

      return toBoardCard(
        card,
        entries,
        resolution,
        // PR の状態を引けないカードは列が控えに依るので、どの列へも動かさせない（画面と `ai-board decide` の両方が従う）
        { floorStage, droppableStages: mrFailure === null ? droppableStages(floorStage) : [] },
        latestReview(entries, resolution.stage),
        toBoardCardPlan(plan),
        toBoardCardMr(mr),
        resolveHold({
          ...resolution,
          entries,
          mr,
          mrKnown,
          mrFailure,
        }),
        splitAiPhases(
          resolveTimeline({
            created: card.created,
            startedAt: card.startedAt,
            skipGates: card.skipGates,
            entries,
            readyAt: mr?.readyAt ?? null,
            mergedAt: mr?.mergedAt ?? null,
            convertedToDraftAt: mr?.convertedToDraftAt ?? null,
          }),
          steps
        ),
        steps
      );
    });

    // カードが無いのに計画ファイルだけ残っているもの。カードを消したか
    // 名前を変えたときに起きる。UI で気付けるように返す。
    const orphanPlans = [...planState.keys()].filter((id) => !cardIds.has(id));

    return ok({
      cards: boardCards,
      forge,
      orphanPlans: orphanPlans.sort(),
      ideaDivider,
      loop: toBoardLoop(loopSteps),
      generatedAt: new Date().toISOString(),
    });
  };
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

function toBoardCardMr(mr: MrState | null): BoardCardMr | null {
  if (mr === null) return null;

  return {
    forge: mr.forge,
    iid: mr.iid,
    state: mr.state,
    draft: mr.draft,
    title: mr.title,
    webUrl: mr.webUrl,
    noteCount: mr.noteCount,
    latestNoteAt: mr.latestNoteAt,
    latestAiNoteAt: mr.latestAiNoteAt,
    latestCommitAt: mr.latestCommitAt,
    resubmitted: hasFixAfterReview(mr),
    awaitingFix: awaitsPrFix(mr),
    mergedAt: mr.mergedAt,
    readyAt: mr.readyAt,
    convertedToDraftAt: mr.convertedToDraftAt,
  };
}
