import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// 手順書の版 — `.claude/HARNESS_VERSIONS.md` の先頭の版
// ============================================================

/**
 * 手順書（`.claude/` のスキル・サブエージェント）の変更履歴。リポジトリの根からの場所。
 *
 * `## v<番号> — <YYYY-MM-DD>` の見出しと、その下の箇条（何を変えたか）を新しい順に並べる。
 * 先頭の見出しの版が今の版である。版を上げるかは人が計画レビューで決める。
 */
export const HARNESS_VERSIONS_FILE = path.join('.claude', 'HARNESS_VERSIONS.md');

const VERSION_HEADING = /^##\s+(v[1-9]\d*)(?:\s|$)/;

/** 変更履歴の文から、先頭の `## v<番号>` の版を読む。無ければ null */
export function parseHarnessVersion(text: string): string | null {
  for (const line of text.split(/\r?\n/)) {
    const match = VERSION_HEADING.exec(line);
    if (match !== null) return match[1] ?? null;
  }
  return null;
}

/**
 * `root` のリポジトリの今の手順書の版。ファイルが無い・読めない・版の見出しが無ければ null。
 *
 * ループが読み込む手順書はメインのチェックアウトのものなので、`root` にはメインのチェックアウトを渡す。
 */
export function readHarnessVersion(root: string): string | null {
  try {
    return parseHarnessVersion(fs.readFileSync(path.join(root, HARNESS_VERSIONS_FILE), 'utf-8'));
  } catch {
    return null;
  }
}
