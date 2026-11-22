import { err, isErr, ok, type Result } from '../shared/result.js';
import { describeCliError, type CliError, type CliRunner, type RunOptions } from './cli-runner.js';

// ============================================================
// git のオブジェクトを読む小さな補助 — 置き場所・計画の読み取り・ブランチの検査が共有する
// ============================================================

/** `git -C <repoDir> <args>` を走らせる関数。引数は配列で渡し、shell を介さない */
export type Git = (
  args: readonly string[],
  options?: RunOptions
) => Promise<Result<string, CliError>>;

export function gitIn(runner: CliRunner, repoDir: string): Git {
  return (args, options = {}) => runner.run('git', ['-C', repoDir, ...args], options);
}

/** コミットの中のファイル 1 つ */
export interface BlobAtCommit {
  /** リポジトリのルートからの相対パス */
  readonly path: string;
  readonly content: string;
}

/** 読めなかった理由。`operation` は失敗した git のサブコマンド */
export interface GitReadError {
  readonly operation: string;
  readonly message: string;
}

/**
 * `commit` の `roots` の下のファイルのうち、`accept` が真のものを読む（`ls-tree` と `cat-file --batch` の 2 回）。
 * `accept` で中身を読む前に絞るので、同じディレクトリに UTF-8 でないファイル（画像など）があっても読める。
 */
export async function readBlobs(
  git: Git,
  commit: string,
  roots: readonly string[],
  accept: (filePath: string) => boolean
): Promise<Result<readonly BlobAtCommit[], GitReadError>> {
  const listed = await git(['ls-tree', '-r', '-z', commit, '--', ...roots]);
  if (isErr(listed)) return err(gitReadError('ls-tree', listed.error));

  const entries = listed.value
    .split('\0')
    .filter((line) => line !== '')
    .flatMap((line) => {
      const tab = line.indexOf('\t');
      const [, type, object] = line.slice(0, tab).split(' ');
      const filePath = line.slice(tab + 1);
      return type === 'blob' && object !== undefined && accept(filePath)
        ? [{ object, path: filePath }]
        : [];
    });
  if (entries.length === 0) return ok([]);

  const read = await git(['cat-file', '--batch'], {
    input: entries.map((entry) => `${entry.object}\n`).join(''),
  });
  if (isErr(read)) return err(gitReadError('cat-file', read.error));

  const contents = parseCatFileBatch(read.value);
  if (contents.length !== entries.length) {
    return err({ operation: 'cat-file', message: '読んだ中身の数がファイルの数と合いません' });
  }
  return ok(entries.map((entry, i) => ({ path: entry.path, content: contents[i] ?? '' })));
}

/** git の失敗を、操作の名前と利用者向けの 1 行にする（stderr の本文は載せない。`describeCliError`） */
export function gitReadError(operation: string, error: CliError): GitReadError {
  return { operation, message: describeCliError(error) };
}

/**
 * `git cat-file --batch` の出力を、blob ごとの中身に分ける。
 * 見出しの大きさはバイト数なので、UTF-8 のバイト列に戻してから切り出す（読むファイルは UTF-8 のテキスト）
 */
export function parseCatFileBatch(output: string): string[] {
  const bytes = Buffer.from(output, 'utf-8');
  const contents: string[] = [];
  let at = 0;
  while (at < bytes.length) {
    const newline = bytes.indexOf(0x0a, at);
    if (newline < 0) break;
    const header = bytes.subarray(at, newline).toString('utf-8').split(' ');
    const size = Number(header[2]);
    if (header[1] === 'missing' || !Number.isInteger(size)) {
      contents.push('');
      at = newline + 1;
      continue;
    }
    contents.push(bytes.subarray(newline + 1, newline + 1 + size).toString('utf-8'));
    at = newline + 1 + size + 1;
  }
  return contents;
}
