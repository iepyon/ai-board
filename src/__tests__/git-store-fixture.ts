import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCliRunner } from '../infrastructure/cli-runner.js';
import { initialDocuments } from '../infrastructure/document-store.js';
import type { LockOptions } from '../infrastructure/file-lock.js';
import { GitDocumentStore } from '../infrastructure/git-document-store.js';
import { cardFileCodec } from '../cards/repositories/card-file-codec.js';
import {
  EMPTY_ORDER,
  ORDER_COLLECTION,
  ORDER_ID,
  orderDocumentData,
} from '../cards/repositories/card-files.js';

// ============================================================
// テストの置き場所 — 一時の bare リポジトリを置き場所のリモートにした GitDocumentStore
// ============================================================

/**
 * 一時のディレクトリに、置き場所のリモート（bare）とコードのリポジトリ（メインのチェックアウトにあたる）を作る。
 * 置き場所のファイルの形は本物と同じ `cardFileCodec`、手元に置くコレクションは `snapshots` と `loop`。
 */
export interface GitStoreFixture {
  readonly root: string;
  /** 置き場所のリモート（bare） */
  readonly bare: string;
  /** コードのリポジトリ */
  readonly repo: string;
  /** 手元のファイルのディレクトリ */
  readonly localDir: string;
  /** 同じ置き場所を開く（別のプロセスにあたる）。`localDir` を変えれば別の PC にあたる */
  open(options?: { lockOptions?: LockOptions; localDir?: string }): GitDocumentStore;
  /** 置き場所のブランチのコミットの題（古い順）。置き場所のブランチが無ければ空 */
  commitSubjects(): string[];
  /** 置き場所のブランチのファイル */
  files(): string[];
  /** 置き場所のブランチのファイルの中身 */
  show(filePath: string): string;
  remove(): void;
}

export function createGitStoreFixture(): GitStoreFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-store-'));
  const bare = path.join(root, 'store.git');
  const repo = path.join(root, 'repo');
  const localDir = path.join(root, 'local');
  fs.mkdirSync(bare);
  git(bare, 'init', '--quiet', '--bare', '--initial-branch=main');
  fs.mkdirSync(repo);
  git(repo, 'init', '--quiet', '--initial-branch=work');
  git(repo, 'config', 'user.name', 'テスト');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');

  const runner = createCliRunner({ timeoutMs: 20_000, maxBuffer: 64 * 1024 * 1024 });
  const hasBranch = (): boolean => git(bare, 'branch', '--list', 'main').trim() !== '';

  return {
    root,
    bare,
    repo,
    localDir,
    open: (options = {}) =>
      new GitDocumentStore({
        repoDir: repo,
        remote: bare,
        branch: 'main',
        localDir: options.localDir ?? localDir,
        localCollections: ['snapshots', 'loop'],
        codec: cardFileCodec,
        runner,
        ...(options.lockOptions === undefined ? {} : { lockOptions: options.lockOptions }),
      }),
    commitSubjects: () =>
      hasBranch() ? git(bare, 'log', '--reverse', '--format=%s', 'main').trim().split('\n') : [],
    files: () =>
      hasBranch()
        ? git(bare, 'ls-tree', '-r', '--name-only', 'main')
            .trim()
            .split('\n')
            .filter((name) => name !== '')
        : [],
    show: (filePath) => git(bare, 'show', `main:${filePath}`),
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** `ai-board store init` と同じ最初の文書（形の版と空の並び順）を書いた置き場所を開く */
export async function initializedStore(fixture: GitStoreFixture): Promise<GitDocumentStore> {
  const store = fixture.open();
  const result = await store.initialize([
    ...initialDocuments(),
    { collection: ORDER_COLLECTION, id: ORDER_ID, data: orderDocumentData(EMPTY_ORDER) },
  ]);
  if (!result.ok) throw new Error(`置き場所を始められません: ${result.error.type}`);
  const checked = await store.check();
  if (!checked.ok) throw new Error(`置き場所を読めません: ${checked.error.type}`);
  return store;
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}
