import { Router } from 'express';
import type { Request, Response } from 'express';
import { STAGES } from '../../shared/schemas/common.js';
import { mapGetBoardErrorToResponse } from './board-error-mappings.js';
import type { BoardDependencies } from '../composition.js';

// ============================================================
// ボードルーターファクトリ
// ============================================================

export function createBoardRouter(deps: BoardDependencies): Router {
  const router = Router();
  const { getBoardQuery } = deps;

  /** GET /api/board — 全カード＋導出ステージ＋計画 / レビュー要求 由来の情報 */
  router.get('/', async (_req: Request, res: Response): Promise<void> => {
    const result = await getBoardQuery();

    if (!result.ok) {
      const { status, response } = mapGetBoardErrorToResponse(result.error);
      res.status(status).json(response);
      return;
    }

    res.json({ stages: STAGES, ...result.value });
  });

  return router;
}
