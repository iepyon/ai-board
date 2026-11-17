import type { StoreError } from './document-store.js';

// ============================================================
// 置き場所の読み書きの失敗を、人が次に何をすればよいかの文にする
// ============================================================

/**
 * `StoreError` を CLI の 1 行にする。
 *
 * Artifact の DB との行き来は Claude が `board-store` のスキルの手順で行うので、
 * 取り込み・送り出しが要るときはそのスキルを案内する。
 */
export function describeStoreError(error: StoreError): string {
  switch (error.type) {
    case 'StoreNotConfigured':
      return (
        '置き場所が設定されていません。.ai-board/config.yaml の store.url にボードの Artifact の URL を書いてください' +
        '（用意の仕方は board-store のスキル）'
      );
    case 'StoreNotPulled':
      return (
        `置き場所の写しがありません（${error.mirrorDir}）。` +
        'Claude に「ボードを取り込んで」と頼むか、board-store のスキルの手順で取り込んでください'
      );
    case 'StoreUninitialized':
      return '置き場所が空です（board/meta がありません）。ai-board store init を走らせて送り出してください';
    case 'StoreVersionMismatch':
      return (
        `置き場所の形の版（${String(error.found)}）が、この CLI の版（${error.expected}）と違うため読みません。` +
        'CLI を置き場所に合う版に更新してください'
      );
    case 'StorePendingWrites':
      return (
        `送る箱に送っていない書き込みが ${error.count} 件あります。` +
        '先に送り出す（board-store のスキル）か、ai-board store discard で捨ててください'
      );
    case 'StoreLockTimeout':
      return `ほかの ai-board が置き場所に書いています（${error.lockPath}）。しばらくしてからやり直してください`;
    case 'StoreInvalidDocument':
      return `取り込もうとした文書が読めません（${error.path}: ${error.reason}）。写しは変えていません`;
  }
}
