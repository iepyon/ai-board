import express, { type Express, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Board } from '../board/models/board-card.js';
import { buildStatusReport } from '../board/cli/status-cli.js';
import { decisionsFor } from '../shared/dashboard-sections.js';
import { CardIdSchema, type CardId } from '../shared/schemas/common.js';
import type { AppendReviewCommand } from '../cards/usecases/commands/append-review.command.js';

// ============================================================
// バックエンドの API のサンプル（2 つだけ）
// ============================================================

/** 1 回のリクエストで組み立てたボードと、PR の状態の控えを取った時刻（無ければ null） */
export interface LoadedBoard {
  readonly board: Board;
  readonly snapshotTakenAt: string | null;
}

export interface ApiDependencies {
  /** データ用ブランチを取り直し、控えからボードを組み立てる。失敗は人が読む 1 行 */
  readonly loadBoard: () => Promise<
    { ok: true; value: LoadedBoard } | { ok: false; error: string }
  >;
  /** 判断を 1 件、コミットして push する */
  readonly appendReview: AppendReviewCommand;
  readonly now: () => Date;
}

/** 人の判断の追記。AI の種別（提出 / 再提出 / 保留）は受け付けない。否決は理由が要る */
const AppendReviewBodySchema = z
  .object({
    gate: z.literal('plan'),
    kind: z.enum(['承認', '否決', '中止']),
    reason: z.string().max(10_000).default(''),
  })
  .refine((value) => value.kind !== '否決' || value.reason.trim() !== '', {
    message: '否決には理由を書いてください',
    path: ['reason'],
  });

/**
 * `GET /api/board` と `POST /api/cards/:id/reviews` だけを持つ Express のアプリ。
 *
 * 画面とサーバを外した後に、バックエンドの API の形の見本として残したもの（ADR 0017）。
 * GitHub には問い合わせず、PR の状態は控えを読む。ステージを直接指定する口は無い。
 */
export function createApp(deps: ApiDependencies): Express {
  const app = express();
  app.use(express.json({ limit: '200kb' }));

  app.get('/api/board', async (_req: Request, res: Response) => {
    const loaded = await deps.loadBoard();
    if (!loaded.ok) {
      res.status(503).json({ error: 'BoardUnavailable', message: loaded.error });
      return;
    }

    res.json({
      ...buildStatusReport(loaded.value.board, deps.now()),
      snapshotTakenAt: loaded.value.snapshotTakenAt,
    });
  });

  app.post('/api/cards/:id/reviews', async (req: Request, res: Response) => {
    const id = CardIdSchema.safeParse(req.params['id']);
    const body = AppendReviewBodySchema.safeParse(req.body);
    if (!id.success || !body.success) {
      res
        .status(400)
        .json({ error: 'InvalidInput', issues: body.success ? [] : body.error.issues });
      return;
    }

    const loaded = await deps.loadBoard();
    if (!loaded.ok) {
      res.status(503).json({ error: 'BoardUnavailable', message: loaded.error });
      return;
    }

    const card = loaded.value.board.cards.find((c) => c.id === id.data);
    if (card === undefined) {
      res.status(404).json({ error: 'CardNotFound', id: id.data });
      return;
    }

    // `ai-board decide` と同じく、そのカードに出せる判断だけを書く
    const available = decisionsFor(card);
    if (!available.some((d) => d.gate === body.data.gate && d.kind === body.data.kind)) {
      res.status(409).json({
        error: 'DecisionNotAvailable',
        stage: card.stage,
        available: available.map((d) => `${d.gate} ${d.kind}`),
      });
      return;
    }

    const result = await deps.appendReview({ id: id.data as CardId, ...body.data, at: deps.now() });
    if (!result.ok) {
      const status = writeFailureStatus(result.error.type);
      res.status(status).json({ error: result.error.type });
      return;
    }

    res.status(201).json({ id: id.data, ...body.data });
  });

  return app;
}

/** 書けなかったときの HTTP のステータス。カードが無ければ 404、書き込みを拒んだら 409、データ用ブランチの失敗は 503 */
function writeFailureStatus(type: string): number {
  switch (type) {
    case 'CardNotFound':
      return 404;
    case 'CardWriteRefused':
      return 409;
    default:
      return 503;
  }
}
