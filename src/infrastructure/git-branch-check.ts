import { err, isErr, ok, type Result } from '../shared/result.js';
import type { CliRunner } from './cli-runner.js';
import { STORE_REF } from './git-document-store.js';

// ============================================================
// カードのブランチが置き場所のファイルを変えていないかの検査
// ============================================================

export type BranchCheckError =
  /** ブランチが無い・コミットとして読めない */
  | { readonly type: 'BranchNotFound'; readonly branch: string }
  /** 置き場所がまだ fetch されていない（置き場所のブランチが無い） */
  | { readonly type: 'StoreNotFetched' }
  /** git の操作が失敗した */
  | { readonly type: 'BranchCheckFailed'; readonly message: string };

/**
 * 置き場所の参照（`STORE_REF`、`GitDocumentStore.check()` が fetch したもの）と `branch` の分岐点から
 * `branch` までの差分（`git diff --name-only <分岐点> <branch>`）のうち、置き場所のファイルを返す。
 *
 * コミットごとには見ない。main を取り込んだマージのコミットは、取り込んだ置き場所のファイルの変更を含むが、
 * 分岐点からの差分には出ないので、誤って止めない。
 * `branch` は人や AI が書く値なので、オプションとして読まれないよう `--end-of-options` の後に置く。
 */
export async function changedStoreFiles(options: {
  readonly runner: CliRunner;
  readonly repoDir: string;
  readonly branch: string;
  readonly isStoreFile: (filePath: string) => boolean;
}): Promise<Result<readonly string[], BranchCheckError>> {
  const git = (args: readonly string[]): ReturnType<CliRunner['run']> =>
    options.runner.run('git', ['-C', options.repoDir, ...args]);

  const store = await git(['rev-parse', '--verify', '--quiet', `${STORE_REF}^{commit}`]);
  if (isErr(store)) return err({ type: 'StoreNotFetched' });

  const branch = await git([
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${options.branch}^{commit}`,
  ]);
  if (isErr(branch)) return err({ type: 'BranchNotFound', branch: options.branch });
  const tip = branch.value.trim();

  const base = await git(['merge-base', STORE_REF, tip]);
  if (isErr(base)) return err({ type: 'BranchCheckFailed', message: messageOf(base.error) });

  const diff = await git(['diff', '--name-only', '-z', base.value.trim(), tip]);
  if (isErr(diff)) return err({ type: 'BranchCheckFailed', message: messageOf(diff.error) });

  return ok(
    diff.value
      .split('\0')
      .filter((name) => name !== '' && options.isStoreFile(name))
      .sort()
  );
}

function messageOf(error: { readonly type: string }): string {
  return 'message' in error && typeof error.message === 'string' ? error.message : error.type;
}
