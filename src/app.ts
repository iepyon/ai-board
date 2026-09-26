import express from 'express';
import type { Application } from 'express';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  errorHandlerMiddleware,
  notFoundMiddleware,
} from './shared/middleware/error-handler.middleware.js';
import { createCardRouter, createIdeaDividerRouter } from './cards/controllers/card.controller.js';
import { createBoardRouter } from './board/controllers/board.controller.js';
import { createPlanRouter } from './board/controllers/plan.controller.js';
import type { CardDependencies } from './cards/composition.js';
import type { BoardDependencies } from './board/composition.js';
import type { SseHub } from './infrastructure/sse.js';

// ============================================================
// Express Application Factory
// ============================================================

export interface AppDependencies {
  readonly cards: CardDependencies;
  readonly board: BoardDependencies;
  readonly sse?: SseHub | undefined;
  /** ビルド済みフロントエンドの配信元。省略時は dist/web を探す */
  readonly webDir?: string | undefined;
}

/**
 * ローカル専用ツールのため認証やレート制限は持たない。
 * サーバは 127.0.0.1 にのみ bind する（`createServer` 側で担保）。
 */
export function createApp(deps: AppDependencies): Application {
  const application = express();

  application.use(express.json({ limit: '1mb' }));

  application.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  application.use('/api/board', createBoardRouter(deps.board));
  application.use('/api/plans', createPlanRouter(deps.board));
  application.use('/api/cards', createCardRouter(deps.cards));
  application.use('/api/idea-divider', createIdeaDividerRouter(deps.cards));

  if (deps.sse !== undefined) {
    application.get('/api/events', deps.sse.handler());
  }

  application.use('/api', notFoundMiddleware);

  const webDir = deps.webDir ?? defaultWebDir();
  if (webDir !== null) {
    application.use(express.static(webDir));
    // SPA フォールバック。/api 配下は上で処理済み
    application.get(/.*/, (_req, res) => {
      res.sendFile(path.join(webDir, 'index.html'));
    });
  }

  application.use(errorHandlerMiddleware);

  return application;
}

/** ビルド済みの dist/web があればそれを配信する */
function defaultWebDir(): string | null {
  const candidate = fileURLToPath(new URL('./web', import.meta.url));
  return fs.existsSync(path.join(candidate, 'index.html')) ? candidate : null;
}
