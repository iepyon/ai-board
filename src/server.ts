import * as http from 'node:http';
import type { FSWatcher } from 'chokidar';
import { loadConfig, type AppConfig } from './shared/config.js';
import { createCardDependencies } from './cards/composition.js';
import { createBoardDependencies, createMrStateSource } from './board/composition.js';
import { createCliRunner } from './infrastructure/cli-runner.js';
import { SseHub } from './infrastructure/sse.js';
import { startWatching } from './infrastructure/watch.js';
import { openDatabase, watchDatabase } from './infrastructure/database.js';
import { removeServerInfo, writeServerInfo } from './infrastructure/server-info.js';
import { createApp } from './app.js';

// ============================================================
// サーバ起動
// ============================================================

/** ローカル専用ツールなのでループバックにのみ bind する */
export const BIND_HOST = '127.0.0.1';
export const DEFAULT_PORT = 5673;

export interface StartServerOptions {
  readonly root: string;
  readonly port?: number;
  readonly pollIntervalMs?: number;
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  readonly config: AppConfig;
  close(): Promise<void>;
}

export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const config = loadConfig(options.root);
  const sse = new SseHub();

  const db = openDatabase(config.paths.dbPath);
  const cards = createCardDependencies(db, () => sse.broadcast('board-changed'));

  const { provider: mrProvider, poller } = await createMrStateSource(
    config.forge,
    cards.cardRepository,
    createCliRunner(),
    {
      ...(options.pollIntervalMs !== undefined ? { intervalMs: options.pollIntervalMs } : {}),
      onUpdate: () => sse.broadcast('board-changed'),
    }
  );

  const board = createBoardDependencies(
    config.paths.plansDir,
    cards.cardRepository,
    cards.ideaDividerRepository,
    mrProvider
  );

  const app = createApp({ cards, board, sse });
  const server = http.createServer(app);

  const port = await listen(server, options.port ?? DEFAULT_PORT);

  // 計画ファイルはファイル監視、カードは DB の data_version で拾う
  const watcher: FSWatcher = startWatching({
    paths: [config.paths.boardDir],
    onChange: () => sse.broadcast('board-changed'),
  });
  const dbWatcher = watchDatabase(db, () => sse.broadcast('board-changed'));

  poller?.start();

  const url = `http://${BIND_HOST}:${port}`;
  const { dbPath } = config.paths;
  writeServerInfo({ url, pid: process.pid, dbPath, startedAt: new Date().toISOString() });

  return {
    url,
    port,
    config,
    close: async () => {
      removeServerInfo(dbPath, process.pid);
      poller?.stop();
      sse.close();
      dbWatcher.close();
      await watcher.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}

/**
 * 指定ポートで待ち受ける。使用中なら 1 つずつ繰り上げて 20 回まで試す。
 * 開発中に前のプロセスが残っていても起動できるようにするため。
 */
async function listen(server: http.Server, startPort: number): Promise<number> {
  const MAX_ATTEMPTS = 20;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const port = startPort + attempt;

    const bound = await tryListen(server, port);
    if (bound) {
      return port;
    }
  }

  throw new Error(
    `ポート ${startPort}〜${startPort + MAX_ATTEMPTS - 1} がすべて使用中です。--port で指定してください。`
  );
}

function tryListen(server: http.Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      if (error.code === 'EADDRINUSE') {
        resolve(false);
        return;
      }
      reject(error);
    };

    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve(true);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, BIND_HOST);
  });
}
