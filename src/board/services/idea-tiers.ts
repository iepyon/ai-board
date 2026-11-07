import { DIVIDER_ID } from '../../shared/card-reorder.js';
import { effectiveRank } from '../../cards/services/card-order.js';

// ============================================================
// アイデアの区切り線
// ============================================================

/** アイデアを区切り線の上下に分けたもの */
export interface IdeaTiers<T> {
  /** 区切り線より上。次に着手する候補 */
  readonly next: T[];
  /** 区切り線より下。あとで考える */
  readonly later: T[];
}

/**
 * `rank` の順に並んだアイデアを、区切り線 `divider`（rank の値）の上下に分ける。
 *
 * 比べるのは並び順の実効値（`effectiveRank`。`rank`、無ければ `created` のエポックミリ秒）。区切り線が未設定なら末尾にあるものとみなし、
 * すべて「次にやる」に入れる。区分は見せ方だけのもので、ステージの導出には使わない。
 */
export function splitIdeas<T extends { readonly rank: number | null; readonly created: string }>(
  ideas: readonly T[],
  divider: number | null
): IdeaTiers<T> {
  if (divider === null) return { next: [...ideas], later: [] };

  const next: T[] = [];
  const later: T[] = [];

  for (const idea of ideas) {
    (effectiveRank(idea) < divider ? next : later).push(idea);
  }

  return { next, later };
}

/** アイデアの表の 1 行。カードか区切り線 */
export type IdeaRow<T> =
  | { readonly kind: 'card'; readonly id: string; readonly card: T }
  | { readonly kind: 'divider'; readonly id: typeof DIVIDER_ID };

/**
 * アイデアの表に並べる行。「次にやる」のカード、区切り線、「あとで考える」のカードの順。
 *
 * 区切り線はカードと同じ 1 行として並びに入れる（並べ替えの `moveInOrder` も、区切り線をカードと同じ 1 項目として扱う）。
 * 未設定の区切り線は末尾に置く。
 */
export function ideaRows<
  T extends { readonly id: string; readonly rank: number | null; readonly created: string },
>(ideas: readonly T[], divider: number | null): IdeaRow<T>[] {
  const { next, later } = splitIdeas(ideas, divider);
  const toRow = (card: T): IdeaRow<T> => ({ kind: 'card', id: card.id, card });

  return [...next.map(toRow), { kind: 'divider', id: DIVIDER_ID }, ...later.map(toRow)];
}
