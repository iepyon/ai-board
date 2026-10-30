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
import type { ReviewEntry } from '../../../cards/models/review.js';
import type { Stage } from '../../../shared/schemas/common.js';
import { GATE_OF_STAGE } from '../../../shared/stage-gates.js';
import {
  toBoardCard,
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
 */
export function createGetBoardQuery(
  cardRepository: CardRepository,
  ideaDividerRepository: IdeaDividerRepository,
  planRepository: PlanRepository,
  mrProvider: MrStateProvider
): GetBoardQuery {
  return async () => {
    let cards;
    let planState;
    let ideaDivider;

    try {
      [cards, planState, ideaDivider] = await Promise.all([
        cardRepository.findAll(),
        planRepository.load(),
        ideaDividerRepository.get(),
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

    const boardCards: BoardCard[] = cards.map((card) => {
      const plan = planState.get(card.id) ?? null;
      const mr = mrProvider.get(card.id);

      const resolution = resolveStage(card, plan, mr);
      const floorStage = resolveFloorStage(card, plan, mr);
      const entries = parseReviewLog(card.body);

      return toBoardCard(
        card,
        resolution,
        { floorStage, droppableStages: droppableStages(floorStage) },
        latestReview(entries, resolution.stage),
        toBoardCardPlan(plan),
        toBoardCardMr(mr),
        resolveHold({ ...resolution, entries, mr, mrKnown })
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
      generatedAt: new Date().toISOString(),
    });
  };
}

function toBoardCardPlan(plan: PlanDoc | null): BoardCardPlan | null {
  if (plan === null) return null;

  return { tasks: plan.tasks, archived: plan.archived, updatedAt: plan.updatedAt };
}

/** その列が待っているゲートの最新エントリ。待ちの列でなければゲートを問わず最新 */
function latestReview(entries: readonly ReviewEntry[], stage: Stage): BoardCardReview | null {
  const entry = latestGateEntry(entries, GATE_OF_STAGE[stage]);
  if (entry === null) return null;

  return { at: entry.at, gate: entry.gate, kind: entry.kind, reason: entry.reason };
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
    latestCommitAt: mr.latestCommitAt,
    resubmitted: hasFixAfterReview(mr),
    mergedAt: mr.mergedAt,
    convertedToDraftAt: mr.convertedToDraftAt,
  };
}
