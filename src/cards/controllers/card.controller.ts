import { Router } from 'express';
import type { Request, Response } from 'express';
import type { z } from 'zod';
import { CardIdSchema, type CardId } from '../../shared/schemas/common.js';
import {
  AppendReviewInputSchema,
  CreateCardInputSchema,
  MoveCardInputSchema,
  UpdateCardBodyInputSchema,
  UpdateCardMetaInputSchema,
} from '../models/schemas/card.schema.js';
import {
  mapCreateCardErrorToResponse,
  mapMoveCardErrorToResponse,
  mapUpdateCardErrorToResponse,
} from './card-error-mappings.js';
import type { Card } from '../models/card.js';
import type { CardDependencies } from '../composition.js';
import type { MoveCardCommand } from '../usecases/commands/move-card.command.js';

// ============================================================
// カードレスポンス変換
// ============================================================

function toCardResponse(card: Card): Record<string, unknown> {
  return {
    id: card.id,
    title: card.title,
    created: card.created,
    startedAt: card.startedAt,
    skipGates: card.skipGates,
    branch: card.branch,
    mr: card.mr,
    rank: card.rank,
    body: card.body,
  };
}

/** Zod のエラーを 400 レスポンスに変換する */
function respondValidationError(res: Response, error: z.ZodError): void {
  res.status(400).json({
    code: 'VALIDATION_ERROR',
    message: error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join(', '),
  });
}

/** パスパラメータの id を検証する。不正なら 404 を返して null */
function parseCardId(req: Request, res: Response): CardId | null {
  const parsed = CardIdSchema.safeParse(req.params['id']);

  if (!parsed.success) {
    res.status(404).json({
      code: 'CARD_NOT_FOUND',
      message: `カードが見つかりません: ${String(req.params['id'])}`,
    });
    return null;
  }

  return parsed.data as CardId;
}

// ============================================================
// カードルーターファクトリ
// ============================================================

export function createCardRouter(deps: CardDependencies): Router {
  const router = Router();
  const {
    createCardCommand,
    updateCardMetaCommand,
    updateCardBodyCommand,
    appendReviewCommand,
    moveCardCommand,
    cardRepository,
  } = deps;

  /** GET /api/cards/:id — カード 1 件 */
  router.get('/:id', async (req: Request, res: Response): Promise<void> => {
    const id = parseCardId(req, res);
    if (id === null) return;

    const card = await cardRepository.findById(id);
    if (card === null) {
      res.status(404).json({ code: 'CARD_NOT_FOUND', message: `カードが見つかりません: ${id}` });
      return;
    }

    res.json(toCardResponse(card));
  });

  /** POST /api/cards — 新規アイデアカード作成 */
  router.post('/', async (req: Request, res: Response): Promise<void> => {
    const input = CreateCardInputSchema.safeParse(req.body);
    if (!input.success) {
      respondValidationError(res, input.error);
      return;
    }

    const result = await createCardCommand({
      title: input.data.title,
      id: input.data.id,
      body: input.data.body,
      createdAt: new Date(),
    });

    if (!result.ok) {
      const { status, response } = mapCreateCardErrorToResponse(result.error);
      res.status(status).json(response);
      return;
    }

    res.status(201).json(toCardResponse(result.value));
  });

  /** PATCH /api/cards/:id — frontmatter の部分更新 */
  router.patch('/:id', async (req: Request, res: Response): Promise<void> => {
    const id = parseCardId(req, res);
    if (id === null) return;

    const input = UpdateCardMetaInputSchema.safeParse(req.body);
    if (!input.success) {
      respondValidationError(res, input.error);
      return;
    }

    const result = await updateCardMetaCommand({ id, patch: input.data });

    if (!result.ok) {
      const { status, response } = mapUpdateCardErrorToResponse(result.error);
      res.status(status).json(response);
      return;
    }

    res.json(toCardResponse(result.value));
  });

  /** PUT /api/cards/:id/body — 本文の差し替え */
  router.put('/:id/body', async (req: Request, res: Response): Promise<void> => {
    const id = parseCardId(req, res);
    if (id === null) return;

    const input = UpdateCardBodyInputSchema.safeParse(req.body);
    if (!input.success) {
      respondValidationError(res, input.error);
      return;
    }

    const result = await updateCardBodyCommand({ id, body: input.data.body });

    if (!result.ok) {
      const { status, response } = mapUpdateCardErrorToResponse(result.error);
      res.status(status).json(response);
      return;
    }

    res.json(toCardResponse(result.value));
  });

  /** POST /api/cards/:id/reviews — レビューエントリの追記 */
  router.post('/:id/reviews', async (req: Request, res: Response): Promise<void> => {
    const id = parseCardId(req, res);
    if (id === null) return;

    const input = AppendReviewInputSchema.safeParse(req.body);
    if (!input.success) {
      respondValidationError(res, input.error);
      return;
    }

    const result = await appendReviewCommand({
      id,
      gate: input.data.gate,
      kind: input.data.kind,
      reason: input.data.reason,
      at: new Date(),
    });

    if (!result.ok) {
      const { status, response } = mapUpdateCardErrorToResponse(result.error);
      res.status(status).json(response);
      return;
    }

    res.json(toCardResponse(result.value));
  });

  /** POST /api/cards/:id/move — 直前・直後のカードの間へ並べ替える */
  router.post('/:id/move', createMoveHandler(moveCardCommand));

  return router;
}

function createMoveHandler(moveCardCommand: MoveCardCommand) {
  return async (req: Request, res: Response): Promise<void> => {
    const id = parseCardId(req, res);
    if (id === null) return;

    const input = MoveCardInputSchema.safeParse(req.body);
    if (!input.success) {
      respondValidationError(res, input.error);
      return;
    }

    const { after, before } = input.data;
    if (after === id || before === id) {
      res.status(400).json({
        code: 'VALIDATION_ERROR',
        message: '自分自身を隣のカードに指定することはできません',
      });
      return;
    }

    const result = await moveCardCommand({
      id,
      after: after as CardId | null,
      before: before as CardId | null,
    });

    if (!result.ok) {
      const { status, response } = mapMoveCardErrorToResponse(result.error);
      res.status(status).json(response);
      return;
    }

    res.json(toCardResponse(result.value));
  };
}
