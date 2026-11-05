import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { loadConfig, resolvePaths } from '../shared/config.js';
import { createCliRunner } from '../infrastructure/cli-runner.js';
import {
  createBoardDataStore,
  createFileCardDependencies,
  createTransactionalCardDependencies,
} from '../cards/composition.js';
import { describeDataStoreError } from '../cards/cli/data-store-messages.js';
import {
  createBoardDependencies,
  createFileMrSnapshotRepository,
  createLoopHistoryRepository,
} from '../board/composition.js';
import { disabledMrStateProvider } from '../board/services/mr-state-provider.js';
import { createSnapshotMrStateProvider } from '../board/services/snapshot-mr-state-provider.js';
import { MR_SNAPSHOT_CACHE_FILE } from '../board/repositories/file-mr-snapshot.repository.js';
import { createApp, type ApiDependencies } from './app.js';

// ============================================================
// ai-board serve — API のサンプルを待ち受ける
// ============================================================

export const BIND_HOST = '127.0.0.1';
export const DEFAULT_PORT = 5673;

export interface RunningApi {
  readonly url: string;
  readonly close: () => Promise<void>;
}

/**
 * `127.0.0.1` にだけ bind して、API のサンプル（`createApp`）を待ち受ける。
 *
 * 認証を持たないローカル専用である。SSE・ファイル監視・定期の取り直し・GitHub のポーリングは持たず、
 * リクエストのたびにデータ用ブランチを取り直し、PR の状態は控えを読む（GitHub には問い合わせない）。
 */
export async function startApiServer(
  root: string,
  port: number = DEFAULT_PORT
): Promise<RunningApi> {
  const server = http.createServer(createApp(createApiDependencies(root)));

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND_HOST, () => resolve());
  });

  const address = server.address();
  const bound = typeof address === 'object' && address !== null ? address.port : port;

  return {
    url: `http://${BIND_HOST}:${bound}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** `ai-board status` と同じ置き場所のデータ用ブランチと控えを、リクエストのたびに読む依存 */
export function createApiDependencies(root: string): ApiDependencies {
  const paths = resolvePaths(root);
  const store = createBoardDataStore(paths, createCliRunner());
  const snapshots = createFileMrSnapshotRepository(store);

  return {
    loadBoard: async () => {
      const refreshed = await store.refresh();
      if (!refreshed.ok) return { ok: false, error: describeDataStoreError(refreshed.error) };

      const config = loadConfig(root);
      const cards = createFileCardDependencies(store.dataDir);
      const provider =
        config.forge === null
          ? disabledMrStateProvider
          : createSnapshotMrStateProvider(config.forge.kind, await snapshots.findAll());

      const { getBoardQuery } = createBoardDependencies(
        config.paths.plansDir,
        cards.cardRepository,
        cards.ideaDividerRepository,
        provider,
        createLoopHistoryRepository(store.dataDir)
      );

      const board = await getBoardQuery();
      if (!board.ok) return { ok: false, error: board.error.reason };

      return {
        ok: true,
        value: { board: board.value, snapshotTakenAt: snapshotTakenAt(store.dataDir) },
      };
    },
    appendReview: createTransactionalCardDependencies(store).appendReviewCommand,
    now: () => new Date(),
  };
}

/** 開いている PR の控え（`cache/mr-snapshots.json`）を最後に書いた時刻。無ければ null */
function snapshotTakenAt(dataDir: string): string | null {
  try {
    return fs
      .statSync(path.join(path.dirname(dataDir), MR_SNAPSHOT_CACHE_FILE))
      .mtime.toISOString();
  } catch {
    return null;
  }
}
