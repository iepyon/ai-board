import type { ForgeConnection } from '../models/mr-state.js';
import type { NextAction } from '../services/next-action.js';

// ============================================================
// ai-board status の文言 — 人向けの数行と HTML の両方で使う
// ============================================================

/** 次の一手の 1 行。無ければ、GitHub につながっているかで理由を分ける */
export function describeNext(next: NextAction | null, forge: ForgeConnection): string {
  if (next !== null) return `${next.action} ${next.cardId}（${next.reason}）`;

  return forge.status === 'connected'
    ? 'なし（AI が進められるカードはありません）'
    : 'なし（GitHub に接続できないため、ループは止まります）';
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
