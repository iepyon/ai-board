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
 * `accept` を通ったファイルでも、中身が UTF-8 として読めなければ警告して読み飛ばす（1 つのファイルでほかを読めなくしない）。
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
    // バイト数で切り出すので、UTF-8 として読み替えずにバイト列のまま受け取る
    encoding: 'latin1',
  });
  if (isErr(read)) return err(gitReadError('cat-file', read.error));

  const contents = parseCatFileBatch(read.value);
  if (contents.length !== entries.length) {
    return err({ operation: 'cat-file', message: '読んだ中身の数がファイルの数と合いません' });
  }
  return ok(
    entries.flatMap((entry, i) => {
      const content = contents[i];
      if (content === null || content === undefined) {
        console.warn(`[ai-board] UTF-8 として読めないファイルを読み飛ばしました: ${entry.path}`);
        return [];
      }
      return [{ path: entry.path, content }];
    })
  );
}

/** git の失敗を、操作の名前と利用者向けの 1 行にする（stderr の本文は載せない。`describeCliError`） */
export function gitReadError(operation: string, error: CliError): GitReadError {
  return { operation, message: describeCliError(error) };
}

/**
 * `git cat-file --batch` の出力（`latin1` で読んだもの）を、blob ごとの中身に分ける。
 * 見出しの大きさはバイト数なので、バイト列に戻してから切り出し、blob ごとに UTF-8 として読む。
 * UTF-8 として読めない blob は null にする（ほかの blob の切り出しはずれない）
 */
export function parseCatFileBatch(output: string): (string | null)[] {
  const bytes = Buffer.from(output, 'latin1');
  const contents: (string | null)[] = [];
  let at = 0;
  while (at < bytes.length) {
    const newline = bytes.indexOf(0x0a, at);
    if (newline < 0) break;
    const header = bytes.subarray(at, newline).toString('latin1').split(' ');
    const size = Number(header[2]);
    if (header[1] === 'missing' || !Number.isInteger(size)) {
      contents.push('');
      at = newline + 1;
      continue;
    }
    contents.push(decodeUtf8(bytes.subarray(newline + 1, newline + 1 + size)));
    at = newline + 1 + size + 1;
  }
  return contents;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
