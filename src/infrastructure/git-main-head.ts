import { err, isErr, ok, type Result } from '../shared/result.js';
import type { CliError, CliRunner } from './cli-runner.js';
import type { StoreError } from './document-store.js';
import { gitIn, gitReadError } from './git-objects.js';

// ============================================================
// main の先頭 — マージ済みの計画を読むために、main を専用の参照へ fetch する
// ============================================================

/** fetch した main の先頭を置く参照。追跡ブランチや `FETCH_HEAD` を、ほかの git の操作と取り合わない */
export const STORE_REF = 'refs/ai-board/store';

/** リモートの名前か（パスや URL でないか）。fetch に失敗したとき、名前ならリポジトリに設定があるかを確かめる */
export function isRemoteName(remote: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(remote) && !remote.startsWith('.');
}

/**
 * `remote` の `branch` の先頭を `STORE_REF` に取り、そのコミットを返す。ブランチがまだ無ければ null。
 * まず fetch だけを走らせ、失敗したときだけ、リモートが無いのか・ブランチが無いのか・届かないのかを見分ける。
 * 作業ツリー・index・今のブランチには触らない。
 */
export async function fetchMainHead(options: {
  readonly runner: CliRunner;
  readonly repoDir: string;
  readonly remote: string;
  readonly branch: string;
}): Promise<Result<string | null, StoreError>> {
  const { remote, branch } = options;
  const git = gitIn(options.runner, options.repoDir);

  const fetched = await git([
    'fetch',
    '--quiet',
    '--no-tags',
    '--no-write-fetch-head',
    remote,
    `+refs/heads/${branch}:${STORE_REF}`,
  ]);
  if (isErr(fetched)) {
    if (isRemoteName(remote) && isErr(await git(['remote', 'get-url', remote]))) {
      return err({ type: 'StoreRemoteMissing', remote });
    }
    const listed = await git(['ls-remote', '--heads', remote, `refs/heads/${branch}`]);
    if (listed.ok && listed.value.trim() === '') {
      await git(['update-ref', '-d', STORE_REF]);
      return ok(null);
    }
    return err(gitFailed('fetch', fetched.error));
  }

  const head = await git(['rev-parse', '--verify', `${STORE_REF}^{commit}`]);
  if (isErr(head)) return err(gitFailed('rev-parse', head.error));
  return ok(head.value.trim());
}

function gitFailed(operation: string, error: CliError): StoreError {
  const failed = gitReadError(operation, error);
  return { type: 'StoreGitFailed', operation: failed.operation, message: failed.message };
}
