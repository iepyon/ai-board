import type { Stage } from './schemas/common.js';

/**
 * その列が人の判断を待っているゲート。待ちの列でなければ undefined。
 *
 * 値は `ReviewGate`（`src/cards/models/review.ts`）と同じ。`src/shared/` はコンテキストの型を引かない
 * （画面を外す前に画面からも読んでいた名残で、置き場所は変えていない）ので、リテラルで書く。
 * ボードの `latestReview` がどのゲートのエントリを選ぶかに使う。
 */
export const GATE_OF_STAGE: Partial<Record<Stage, 'plan'>> = {
  'plan-review': 'plan',
};

/**
 * 飛ばす宣言（`skipGates`）に `gate` を入れる / 外した後の値。他のゲートの宣言はそのまま保つ。
 *
 * 宣言を書くのは人だけ（`ai-board decide skip`）。AI の CLI（`ai-board card`）に入口は無い。
 * 既に入っているものを入れても、無いものを外しても値は変わらない。
 */
export function withSkipGate(skipGates: readonly 'plan'[], gate: 'plan', skip: boolean): 'plan'[] {
  const others = skipGates.filter((each) => each !== gate);

  return skip ? [...others, gate] : others;
}
