import { ok, err, type Result } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { PlanRepository } from '../../repositories/plan.repository.js';
import { countTasks } from '../../repositories/plan.repository.js';
import type { PlanDocument } from '../../models/plan-state.js';
import type { GetPlanError } from '../../errors/board-errors.js';

// ============================================================
// 計画取得ユースケース
// ============================================================

export type GetPlanQuery = (id: CardId) => Promise<Result<PlanDocument, GetPlanError>>;

/**
 * 計画 1 件の本文を返す。
 *
 * ボードのレスポンスには載せない。計画はカード本文より桁違いに大きく、
 * ファイル変更のたびに引き直される `GET /api/board` に混ぜると肥大するため、
 * 詳細パネルを開いたときだけ取りに行く。
 */
export function createGetPlanQuery(planRepository: PlanRepository): GetPlanQuery {
  return async (id) => {
    let body: string | null;

    try {
      body = await planRepository.readBody(id);
    } catch (error) {
      return err({
        type: 'PlanUnreadable',
        id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    if (body === null) {
      return err({ type: 'PlanNotFound', id });
    }

    return ok({ cardId: id, body, tasks: countTasks(body) });
  };
}
