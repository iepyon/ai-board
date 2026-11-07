import { forgeTrusted, isForgeUnset, type ForgeConnection } from '../models/pr-state.js';
import type { NextAction } from '../services/next-action.js';
import { summarizeLoop, type BoardLoop } from '../services/loop-activity.js';
import { STREAK_THRESHOLD, stuckStreak, type StreakStep } from '../services/loop-streak.js';

// ============================================================
// ai-board status の文言 — 人向けの数行と HTML の両方で使う
// ============================================================

/**
 * 次の一手の 1 行。無ければ、GitHub が接続済みか未設定（`forgeTrusted`）かで理由を分ける。
 *
 * `implement` の手では段（`next.step`）を `段=task` のように添える。
 * 段を読めなかった（`step` が null）ときは `段=不明` とし、ループが `implement.md` で計画を読み直して段を確かめることが分かるようにする
 */
export function describeNext(next: NextAction | null, forge: ForgeConnection): string {
  if (next !== null) return `${next.action} ${next.cardId}${describeStep(next)}（${next.reason}）`;

  return forgeTrusted(forge)
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
      return isForgeUnset(forge) ? '未設定' : `使えません（${forge.reason ?? '理由不明'}）`;
  }
}

/**
 * ループの様子の 1 行（「ループ: …」。`summarizeLoop`）。
 * 経過時間は `generatedAt` までを数える
 */
export function describeLoop(report: {
  readonly loop: BoardLoop;
  readonly cards: readonly { readonly id: string; readonly title: string }[];
  readonly generatedAt: string;
}): string {
  const titles = new Map(report.cards.map((card) => [card.id, card.title]));
  return summarizeLoop(report.loop, report.generatedAt, (id) => titles.get(id) ?? null).text;
}

/**
 * 同じ手で止まり続けている印（例: `止まった ×3`）。`STREAK_THRESHOLD` 回より少なければ null。
 * 数えて見せるだけで、上限で止めることはしない（`loop-retry-limit`）
 */
export function describeStuck(steps: readonly StreakStep[]): string | null {
  const count = stuckStreak(steps);
  return count < STREAK_THRESHOLD ? null : `止まった ×${count}`;
}
