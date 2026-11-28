import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Result } from '../shared/result.js';
import { BackedDocumentStore, type StoreBackend } from '../infrastructure/backed-document-store.js';
import { DirStoreBackend, LOCAL_COLLECTIONS } from '../infrastructure/dir-store-backend.js';
import type { StoreError } from '../infrastructure/document-store.js';
import type { LockOptions } from '../infrastructure/file-lock.js';
import { initialBoardDocuments } from '../cards/composition.js';

// ============================================================
// テストの置き場所 — 一時のディレクトリを共有の置き場所にした BackedDocumentStore
// ============================================================

/**
 * 一時のディレクトリに、共有の置き場所（JSON のディレクトリ）とコードのリポジトリ（メインのチェックアウトにあたる）を作る。
 * 書き込みの 1 操作ごとの名前を `writeLabels()` に残す（書き込みが起きたか・何回かを確かめる）。
 */
export interface StoreFixture {
  readonly root: string;
  /** コードのリポジトリ（計画のファイルを置く） */
  readonly repo: string;
  /** 共有の置き場所のディレクトリ */
  readonly storeDir: string;
  /** 手元のファイルのディレクトリ */
  readonly localDir: string;
  /** 同じ置き場所を開く（別のプロセスにあたる）。`localDir` を変えれば別の PC にあたる */
  open(options?: { lockOptions?: LockOptions; localDir?: string }): BackedDocumentStore;
  /** 書き込みの 1 操作の名前（古い順）。共有の置き場所へ書いたものだけ */
  writeLabels(): string[];
  remove(): void;
}

export function createStoreFixture(): StoreFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-store-'));
  const storeDir = path.join(root, 'store');
  const repo = path.join(root, 'repo');
  const localDir = path.join(root, 'local');
  fs.mkdirSync(repo);
  git(repo, 'init', '--quiet', '--initial-branch=work');
  git(repo, 'config', 'user.name', 'テスト');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');

  const labels: string[] = [];
  const recording = (inner: StoreBackend): StoreBackend => ({
    load: () => inner.load(),
    async apply(writes, before, label): Promise<Result<void, StoreError>> {
      const applied = await inner.apply(writes, before, label);
      if (applied.ok) labels.push(label);
      return applied;
    },
  });

  return {
    root,
    repo,
    storeDir,
    localDir,
    open: (options = {}) =>
      new BackedDocumentStore({
        backend: recording(new DirStoreBackend(storeDir, LOCAL_COLLECTIONS)),
        localDir: options.localDir ?? localDir,
        localCollections: LOCAL_COLLECTIONS,
        ...(options.lockOptions === undefined ? {} : { lockOptions: options.lockOptions }),
      }),
    writeLabels: () => [...labels],
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** `ai-board store init` と同じ最初の文書（形の版と空の並び順）を書いた置き場所を開く */
export async function initializedStore(fixture: StoreFixture): Promise<BackedDocumentStore> {
  const store = fixture.open();
  const result = await store.initialize(initialBoardDocuments());
  if (!result.ok) throw new Error(`置き場所を始められません: ${result.error.type}`);
  const checked = await store.check();
  if (!checked.ok) throw new Error(`置き場所を読めません: ${checked.error.type}`);
  return store;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}
