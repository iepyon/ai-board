import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, err, type Result } from '../shared/result.js';

// ============================================================
// サーバの pid をファイルに書く（`--pid-file`）
// ============================================================

/** pid のファイルを書けなかった理由 */
export interface PidFileError {
  readonly type: 'PidFileWriteFailed';
  readonly file: string;
  readonly reason: string;
}

/**
 * `pid` を `file` に書く。書けなければ例外を投げず、`PidFileWriteFailed` を返す。
 *
 * `board-decide` のスキルが、起動を待つ間の生存確認と止めるのに使う。
 * Git Bash の `$!` は MSYS の pid で、`node` の `process.kill` が受ける OS の pid とは別の番号なので、
 * サーバ自身が OS の pid を書く。ファイルは書くだけで消さない（スキルが起動の前に消してから使う）。
 *
 * 書けなかったときは、呼び出し側（`cli-main.ts`）が起動をやめて終了コード 1 で終わる。
 * 書けないまま動き続けると、スキルはサーバを止められず、起動を待つ間に終わったことにも気づけないため。
 */
export function writePidFile(file: string, pid: number): Result<void, PidFileError> {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${pid}\n`, 'utf-8');
    return ok(undefined);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return err({ type: 'PidFileWriteFailed', file, reason });
  }
}

/** 起動をやめるときに出す 1 行 */
export function describePidFileError(error: PidFileError): string {
  return `pid のファイルを書けないので起動をやめます（${error.file}: ${error.reason}）`;
}
