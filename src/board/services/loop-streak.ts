import type { LoopStep } from '../models/loop-step.js';

// ============================================================
// 止まり続けている回数 — 同じ手で進めなかった記録の連続
// ============================================================

/** 数えるのに使う記録の項目 */
export type StreakStep = Pick<LoopStep, 'action' | 'step' | 'result'>;

/** 止まり続けている回数を表に出す下限。1 回止まっただけでは出さない */
export const STREAK_THRESHOLD = 2;

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
 * `steps` は開始の古い順に並んでいること（`BoardCard.loopSteps` はリポジトリがその順に並べて渡す。
 * 同じ時刻はファイル名の順で、ここで並べ直すとずれうるので並べ直さない）。
 *
 * 最新の記録から古い方へたどり、最新と同じ手・同じ段で、進めなかった記録が続く数を返す。
 * 最新が進めた（`advanced`）か、終わっていない（今触っている）なら 0。記録が無ければ 0。
 * 上限で止めて人に回すことはしない（`loop-retry-limit` のカード）。数えて見せるだけである。
 */
export function stuckStreak(steps: readonly StreakStep[]): number {
  const newest = [...steps].reverse();
  const latest = newest[0];
  if (latest === undefined) return 0;

  const end = newest.findIndex((step) => !isStuck(step) || !sameMove(step, latest));
  return end === -1 ? newest.length : end;
}
