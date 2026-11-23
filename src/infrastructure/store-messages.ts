import type { StoreError } from './document-store.js';

// ============================================================
// 置き場所の読み書きの失敗を、人が次に何をすればよいかの文にする
// ============================================================

/**
 * `StoreError` を CLI の 1 行にする。
 */
export function describeStoreError(error: StoreError): string {
  switch (error.type) {
    case 'StoreUninitialized':
      return '置き場所が空です（.ai-board/board.yaml がありません）。ai-board store init を走らせてください';
    case 'StoreVersionMismatch':
      return (
        `置き場所の形の版（${String(error.found)}）が、この CLI の版（${error.expected}）と違うため読みません。` +
        'CLI を置き場所に合う版に更新してください'
      );
    case 'StoreLockTimeout':
      return `ほかの ai-board が置き場所に書いています（${error.lockPath}）。しばらくしてからやり直してください`;
    case 'StoreRemoteMissing':
      return (
        `置き場所のリモート ${error.remote} がこのリポジトリにありません。` +
        'git remote add で足すか、.ai-board/config.yaml の store.remote を直してください'
      );
    case 'StoreGitFailed':
      return `置き場所の git の操作（${error.operation}）に失敗しました: ${error.message}`;
    case 'StorePushConflict':
      return (
        `置き場所への push が ${error.attempts} 回とも先を越されました（ほかの人が続けて書いています）。` +
        'しばらくしてからやり直してください'
      );
    case 'StoreAlreadyInitialized':
      return '置き場所は既に始まっています（board/meta があります）';
  }
}
