import type { ForgeConnection } from '../models/mr-state.js';
import type { NextAction } from '../services/next-action.js';

// ============================================================
// ai-board status の文言 — 人向けの数行と HTML の両方で使う
// ============================================================

/**
 * 次の一手の 1 行。無ければ、GitHub につながっているかで理由を分ける。
 *
 * `implement` の手では段（`next.step`）を `段=task` のように添える。
 * 段を読めなかった（`step` が null）ときは `段=不明` とし、監視役が `board-worker` に渡すことが分かるようにする
 */
export function describeNext(next: NextAction | null, forge: ForgeConnection): string {
  if (next !== null) return `${next.action} ${next.cardId}${describeStep(next)}（${next.reason}）`;

  return forge.status === 'connected'
    ? 'なし（AI が進められるカードはありません）'
    : 'なし（GitHub に接続できないため、ループは止まります）';
}

function describeStep(next: NextAction): string {
  if (next.action !== 'implement') return '';
  return ` 段=${next.step ?? '不明'}`;
}

export function describeForge(forge: ForgeConnection): string {
  switch (forge.status) {
    case 'connected':
      return '接続済み';
    case 'error':
      return `エラー（${forge.message}）`;
    case 'disabled':
      return forge.reason === null ? '未設定' : `使えません（${forge.reason}）`;
  }
}
