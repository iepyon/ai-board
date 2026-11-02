import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// サーバの pid をファイルに書く（`--pid-file`）
// ============================================================

/**
 * `pid` を `file` に書く。書けなければ例外を投げず、警告を 1 行出して false を返す。
 *
 * `board-decide` のスキルが、起動を待つ間の生存確認と止めるのに使う。
 * Git Bash の `$!` は MSYS の pid で、`node` の `process.kill` が受ける OS の pid とは別の番号なので、
 * サーバ自身が OS の pid を書く。ファイルは書くだけで消さない（スキルが起動の前に消してから使う）。
 */
export function writePidFile(
  file: string,
  pid: number,
  warn: (message: string) => void = (message) => console.warn(message)
): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${pid}\n`, 'utf-8');
    return true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warn(`[ai-board] pid のファイルを書けませんでした（${file}: ${reason}）`);
    return false;
  }
}
