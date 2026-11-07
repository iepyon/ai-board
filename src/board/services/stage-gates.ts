import type { Stage } from '../../shared/schemas/common.js';
import type { ReviewGate } from '../../cards/models/review.js';

/**
 * その列が人の判断を待っているゲート。待ちの列でなければ undefined。
 *
 * ボードの `latestReview` がどのゲートのエントリを選ぶかに使う。
 */
export const GATE_OF_STAGE: Partial<Record<Stage, ReviewGate>> = {
  'plan-review': 'plan',
};

/**
 * 飛ばす宣言（`skipGates`）に `gate` を入れる / 外した後の値。他のゲートの宣言はそのまま保つ。
 *
 * 宣言を書くのは人だけ（`ai-board decide skip`）。AI の CLI（`ai-board card`）に入口は無い。
 * 既に入っているものを入れても、無いものを外しても値は変わらない。
 */
export function withSkipGate(
  skipGates: readonly ReviewGate[],
  gate: ReviewGate,
  skip: boolean
): ReviewGate[] {
  const others = skipGates.filter((each) => each !== gate);

  return skip ? [...others, gate] : others;
}
