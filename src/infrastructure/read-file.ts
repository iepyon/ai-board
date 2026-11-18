import * as fs from 'node:fs';

// ============================================================
// ファイルを読む
// ============================================================

/** ファイルを UTF-8 で読む。無ければ null、ほかの失敗は投げる */
export function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
