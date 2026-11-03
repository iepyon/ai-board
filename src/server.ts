import * as http from 'node:http';
import * as path from 'node:path';
import type { FSWatcher } from 'chokidar';
import { loadConfig, resolvePaths, type AppConfig } from './shared/config.js';
import { isErr } from './shared/result.js';
import {
  createBoardDataStore,
  createTransactionalCardDependencies,
  createTransactionalMrWriter,
} from './cards/composition.js';
import { describeDataStoreError, describeOfflineRead } from './cards/cli/data-store-messages.js';
import {
  createBoardDependencies,
  createLoopHistoryRepository,
  createFileMrSnapshotRepository,
  createMrStateSource,
} from './board/composition.js';
import { createCliRunner } from './infrastructure/cli-runner.js';
import { LOCK_FILE } from './infrastructure/data-store.js';
import { startDataRefresher, type RefreshProblem } from './infrastructure/data-refresher.js';
import { DEFAULT_POLL_INTERVAL_MS } from './infrastructure/forge-poller.js';
import { MR_SNAPSHOT_CACHE_FILE } from './board/repositories/file-mr-snapshot.repository.js';
import { SseHub } from './infrastructure/sse.js';
import { startWatching } from './infrastructure/watch.js';
import {
  removeServerInfo,
  SERVER_INFO_FILE,
  writeServerInfo,
} from './infrastructure/server-info.js';
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

/**
 * サーバを起動する。
 *
 * カードはデータのワークツリーのファイルから読み、画面の書き込みは `DataStore.transact` を通して
 * コミットと push が終わってから応答する。起動の前に 1 回取り直す（`config.yaml` もデータ用ブランチにある）。
 *
 * ほかの場所（CLI、クラウドのセッション）からの書き込みは、PR のポーリングと同じ間隔でデータ用ブランチを
 * 取り直して拾う。画面へは、計画ファイルとデータのワークツリーのファイル監視が知らせる。
 */
export async function startServer(options: StartServerOptions): Promise<RunningServer> {
  const runner = createCliRunner();
  const paths = resolvePaths(options.root);
  const store = createBoardDataStore(paths, runner);

  const refreshed = await store.refresh();
  if (isErr(refreshed)) {
    throw new Error(describeDataStoreError(refreshed.error));
  }
  if (refreshed.value.kind === 'offline') {
    console.warn(`[ai-board] ${describeOfflineRead(refreshed.value.reason)}`);
  }

  const config = loadConfig(options.root);
  const sse = new SseHub();
  const intervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const cards = createTransactionalCardDependencies(store, () => sse.broadcast('board-changed'));

  const { provider: mrProvider, poller } = await createMrStateSource(
    config.forge,
    cards.cardRepository,
    createFileMrSnapshotRepository(store),
    runner,
    {
      intervalMs,
      onUpdate: () => sse.broadcast('board-changed'),
      // ブランチから解決した PR 番号も、コミットして push する
      writeMr: createTransactionalMrWriter(store),
    }
  );

  const board = createBoardDependencies(
    config.paths.plansDir,
    cards.cardRepository,
    cards.ideaDividerRepository,
    mrProvider,
    createLoopHistoryRepository(store.dataDir)
  );

  const app = createApp({ cards, board, sse });
  const server = http.createServer(app);

  const port = await listen(server, options.port ?? DEFAULT_PORT);

  // 計画ファイルとデータのワークツリーの変化はファイル監視で拾う（CLI の書き込み、取り直しで届いた書き込み）。
  // サーバ自身のカードの書き込みは、push の後に onWrite でも知らせる
  const { boardDir, dataDir } = config.paths;
  const dataParent = path.dirname(dataDir);
  const watcher: FSWatcher = startWatching({
    paths: [boardDir, dataDir],
    // 既定の置き場所では、データのワークツリーの親は `.ai-board/` である。書き込みのたびに作っては消すロック、
    // PR の控え（変化はポーラーが知らせる）、server.json は、ボードのカードの変化ではない
    ignoredPaths: [
      path.join(dataParent, LOCK_FILE),
      path.join(dataParent, path.dirname(MR_SNAPSHOT_CACHE_FILE)),
      path.join(dataParent, SERVER_INFO_FILE),
    ],
    onChange: () => sse.broadcast('board-changed'),
  });

  // 同じ store で取り直す。サーバの書き込みと 1 列に並ぶ
  const refresher = startDataRefresher({ store, intervalMs, onProblem: warnRefreshProblem });

  poller?.start();

  const url = `http://${BIND_HOST}:${port}`;
  writeServerInfo({ url, pid: process.pid, dataDir, startedAt: new Date().toISOString() });

  return {
    url,
    port,
    config,
    close: async () => {
      removeServerInfo(dataDir, process.pid);
      poller?.stop();
      // 走っている取り直しを待つ。閉じた後に git がデータのワークツリーを触らないように
      await refresher.stop();
      sse.close();
      await watcher.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 定期の取り直しの失敗を警告する。オフラインは続く間 1 回だけ届く */
function warnRefreshProblem(problem: RefreshProblem): void {
  switch (problem.kind) {
    case 'offline':
      console.warn(`[ai-board] ${describeOfflineRead(problem.reason)}`);
      return;
    case 'failed':
      console.warn(`[ai-board] ${describeDataStoreError(problem.error)}`);
      return;
    case 'threw':
      console.warn('[ai-board] データ用ブランチの取り直しでエラーが発生しました:', problem.error);
      return;
  }
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
