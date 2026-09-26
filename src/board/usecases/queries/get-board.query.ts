import { ok, err, type Result } from '../../../shared/result.js';
import type { CardRepository } from '../../../cards/repositories/card.repository.js';
import type { PlanRepository } from '../../repositories/plan.repository.js';
import type { MrStateProvider } from '../../services/mr-state-provider.js';
import {
  droppableStages,
  hasFixAfterReview,
  resolveFloorStage,
  resolveStage,
} from '../../services/stage-resolver.js';
import {
  toBoardCard,
  type Board,
  type BoardCard,
  type BoardCardMr,
  type BoardCardPlan,
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
  planRepository: PlanRepository,
  mrProvider: MrStateProvider
): GetBoardQuery {
  return async () => {
    let cards;
    let planState;

    try {
      [cards, planState] = await Promise.all([cardRepository.findAll(), planRepository.load()]);
    } catch (error) {
      return err({
        type: 'BoardUnreadable',
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const cardIds = new Set<string>(cards.map((card) => card.id));

    const boardCards: BoardCard[] = cards.map((card) => {
      const plan = planState.get(card.id) ?? null;
      const mr = mrProvider.get(card.id);

      const floorStage = resolveFloorStage(card, plan, mr);

      return toBoardCard(
        card,
        resolveStage(card, plan, mr),
        { floorStage, droppableStages: droppableStages(floorStage) },
        toBoardCardPlan(plan),
        toBoardCardMr(mr)
      );
    });

    // カードが無いのに計画ファイルだけ残っているもの。カードを消したか
    // 名前を変えたときに起きる。UI で気付けるように返す。
    const orphanPlans = [...planState.keys()].filter((id) => !cardIds.has(id));

    return ok({
      cards: boardCards,
      forge: mrProvider.connection(),
      orphanPlans: orphanPlans.sort(),
      generatedAt: new Date().toISOString(),
    });
  };
}

function toBoardCardPlan(plan: PlanDoc | null): BoardCardPlan | null {
  if (plan === null) return null;

  return { tasks: plan.tasks, archived: plan.archived };
}

function toBoardCardMr(mr: MrState | null): BoardCardMr | null {
  if (mr === null) return null;

  return {
    forge: mr.forge,
    iid: mr.iid,
    state: mr.state,
    title: mr.title,
    webUrl: mr.webUrl,
    noteCount: mr.noteCount,
    latestNoteAt: mr.latestNoteAt,
    latestCommitAt: mr.latestCommitAt,
    resubmitted: hasFixAfterReview(mr),
  };
}
