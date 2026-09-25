import { Router } from 'express';
import type { Request, Response } from 'express';
import { CardIdSchema, type CardId } from '../../shared/schemas/common.js';
import { mapGetPlanErrorToResponse } from './board-error-mappings.js';
import type { BoardDependencies } from '../composition.js';

// ============================================================
// 計画ルーターファクトリ
// ============================================================

/**
 * パスパラメータの id を検証する。不正なら 404 を返して null。
 *
 * 400 ではなく 404 にするのはカード API と揃えるため。
 * 加えて、パストラバーサルを狙った文字列に「その形は不正だ」と
 * 答えて存在を推し量らせない。
 */
function parseCardId(req: Request, res: Response): CardId | null {
  const parsed = CardIdSchema.safeParse(req.params['id']);

  if (!parsed.success) {
    res.status(404).json({
      code: 'PLAN_NOT_FOUND',
      message: `計画が見つかりません: ${String(req.params['id'])}`,
    });
    return null;
  }

  return parsed.data as CardId;
}

export function createPlanRouter(deps: BoardDependencies): Router {
  const router = Router();
  const { getPlanQuery } = deps;

  /** GET /api/plans/:id — 計画の本文。人が計画レビューで読む */
  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const id = parseCardId(req, res);
    if (id === null) return;

    const result = await getPlanQuery(id);

    if (!result.ok) {
      const { status, response } = mapGetPlanErrorToResponse(result.error);
      res.status(status).json(response);
      return;
    }

    res.json({ id: result.value.cardId, body: result.value.body, tasks: result.value.tasks });
  });

  return router;
}
