import { err, isErr, ok, type Result } from '../shared/result.js';
import { describeCliError, type CliRunner } from './cli-runner.js';
import { gitIn } from './git-objects.js';

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
 * 置き場所の先頭（`storeHead`。`GitDocumentStore.check()` の後の `headCommit()`）と `branch` の分岐点から
 * `branch` までの差分（`git diff --name-only <置き場所>...<branch>`）のうち、置き場所のファイルを返す。
 *
 * コミットごとには見ない。main を取り込んだマージのコミットは、取り込んだ置き場所のファイルの変更を含むが、
 * 分岐点からの差分には出ないので、誤って止めない。
 * `branch` は人や AI が書く値なので、オプションとして読まれないよう `--end-of-options` の後に置く。
 */
export async function changedStoreFiles(options: {
  readonly runner: CliRunner;
  readonly repoDir: string;
  readonly storeHead: string | null;
  readonly branch: string;
  readonly isStoreFile: (filePath: string) => boolean;
}): Promise<Result<readonly string[], BranchCheckError>> {
  if (options.storeHead === null) return err({ type: 'StoreNotFetched' });
  const git = gitIn(options.runner, options.repoDir);

  const branch = await git([
    'rev-parse',
    '--verify',
    '--quiet',
    '--end-of-options',
    `${options.branch}^{commit}`,
  ]);
  if (isErr(branch)) return err({ type: 'BranchNotFound', branch: options.branch });

  const diff = await git([
    'diff',
    '--name-only',
    // 名前の変更は移動先だけを出すので、置き場所のファイルを外へ移したのを見逃さないよう、消した側も出させる
    '--no-renames',
    '-z',
    `${options.storeHead}...${branch.value.trim()}`,
  ]);
  if (isErr(diff)) return err({ type: 'BranchCheckFailed', message: describeCliError(diff.error) });

  return ok(
    diff.value
      .split('\0')
      .filter((name) => name !== '' && options.isStoreFile(name))
      .sort()
  );
}
