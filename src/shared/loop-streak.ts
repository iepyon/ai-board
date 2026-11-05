import type { LoopStep } from './loop-step.js';

// ============================================================
// 止まり続けている回数 — 同じ手で進めなかった記録の連続
// ============================================================

/** 数えるのに使う記録の項目 */
export type StreakStep = Pick<LoopStep, 'action' | 'step' | 'result' | 'startedAt'>;

/** 止まり続けている回数を表に出す下限。1 回止まっただけでは出さない */
export const STREAK_THRESHOLD = 2;

/** 開始の古い順に並べる。同じ時刻なら元の順を保つ */
export function byStartedAt<T extends Pick<LoopStep, 'startedAt'>>(steps: readonly T[]): T[] {
  return [...steps].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
}

/** 同じ手・同じ段か */
export function sameMove(a: StreakStep, b: StreakStep): boolean {
  return a.action === b.action && a.step === b.step;
}

/** 終わっていて、進めなかった（`advanced` でない）記録か */
export function isStuck(step: Pick<LoopStep, 'result'>): boolean {
  return step.result !== null && step.result !== 'advanced';
}

/**
 * 1 枚のカードの記録から、同じ手で止まり続けている回数を数える。
 *
 * 最新の記録から古い方へたどり、最新と同じ手・同じ段で、進めなかった記録が続く数を返す。
 * 最新が進めた（`advanced`）か、終わっていない（今触っている）なら 0。記録が無ければ 0。
 * 上限で止めて人に回すことはしない（`loop-retry-limit` のカード）。数えて見せるだけである。
 */
export function stuckStreak(steps: readonly StreakStep[]): number {
  const ordered = byStartedAt(steps);
  const latest = ordered.at(-1);
  if (latest === undefined || !isStuck(latest)) return 0;

  let count = 0;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const step = ordered[i] as StreakStep;
    if (!sameMove(step, latest) || !isStuck(step)) break;
    count += 1;
  }
  return count;
}
