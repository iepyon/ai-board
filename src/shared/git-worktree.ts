import * as fs from 'node:fs';
import * as path from 'node:path';

// ============================================================
// git のリンクされたワークツリーから、メインのチェックアウトを求める
// ============================================================

export type WorktreeLocation =
  /** メインのチェックアウト、git でないディレクトリ、サブモジュールなど。`root` をそのまま使う */
  | { readonly kind: 'standalone' }
  /** `git worktree add` で作られたワークツリー */
  | { readonly kind: 'linked'; readonly mainRoot: string }
  /** ワークツリーらしいが読み解けなかった。`root` にとどめ、理由を警告する */
  | { readonly kind: 'unresolved'; readonly reason: string };

/**
 * `root` がリンクされたワークツリーなら、メインのチェックアウトの場所を返す。
 *
 * ワークツリーの `.git` はファイルで、`gitdir: <メインの .git>/worktrees/<名前>` を持つ。
 * その下の `commondir` がメインの `.git` を指す（`../..` のような相対パス）。
 * `git` を実行せずにファイルだけで求める。
 */
export function locateWorktree(root: string): WorktreeLocation {
  try {
    const dotGit = path.join(root, '.git');
    const stat = statOrNull(dotGit);
    if (stat === null || stat.isDirectory()) {
      return { kind: 'standalone' };
    }

    const match = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, 'utf-8'));
    if (match?.[1] === undefined) {
      return { kind: 'unresolved', reason: `${dotGit} に gitdir がありません` };
    }

    const gitDir = path.resolve(root, match[1]);
    const commonDirFile = path.join(gitDir, 'commondir');
    // サブモジュールの `.git` も gitdir を持つファイルだが commondir は無い。独立したリポジトリとして扱う
    if (statOrNull(commonDirFile) === null) {
      return { kind: 'standalone' };
    }

    const commonDir = path.resolve(gitDir, fs.readFileSync(commonDirFile, 'utf-8').trim());
    if (path.basename(commonDir) !== '.git') {
      return {
        kind: 'unresolved',
        reason: `メインの git ディレクトリが .git ではありません（ベアリポジトリ）: ${commonDir}`,
      };
    }

    return { kind: 'linked', mainRoot: path.dirname(commonDir) };
  } catch (error) {
    return { kind: 'unresolved', reason: error instanceof Error ? error.message : String(error) };
  }
}

function statOrNull(target: string): fs.Stats | null {
  try {
    return fs.statSync(target);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
