import type { Card } from '../models/card.js';

// ============================================================
// カードの並び順 — 純関数のみ。I/O は持たない
// ============================================================

/** 端へ動かすときのずらし幅と、振り直しの刻み幅 */
export const RANK_STEP = 1000;

/**
 * 並びに入る項目。カードのほか、アイデアの表の区切り線も同じ物差しで並ぶ。
 * 区切り線は `rank` を必ず持つので `created` は使われない。
 */
export interface Rankable extends Pick<Card, 'rank' | 'created'> {
  readonly id: string;
}

/**
 * 並び順の実効値。小さいほど上に並ぶ。
 *
 * `rank` が無いカードは `created` のエポックミリ秒で補う。既存のカードは書き換えずに
 * 今までどおり作成順に並び、新しく作られたカードはどのカードよりも大きい値を持つので
 * 列の末尾に付く。作成時に既定値を書く必要が無く、手書きのカードも同じ規則で並ぶ。
 */
export function effectiveRank(card: Pick<Card, 'rank' | 'created'>): number {
  return card.rank ?? Date.parse(card.created);
}

/** 実効値の昇順。同じ値なら id の辞書順で決定的に並べる */
export function compareCards(a: Rankable, b: Rankable): number {
  const diff = effectiveRank(a) - effectiveRank(b);
  if (diff !== 0) return diff < 0 ? -1 : 1;
  return a.id.localeCompare(b.id);
}

/**
 * 直前 `prev` と直後 `next` の間に入る値。`null` はその側が列の端であることを表す。
 *
 * 隙間が尽きた（中点が両端のどちらかと一致する）ときは `null` を返す。
 * 呼び出し側は `rebalance` で振り直してから計算し直す。
 */
export function rankBetween(prev: number | null, next: number | null): number | null {
  if (prev === null && next === null) return 0;
  if (prev === null) return (next as number) - RANK_STEP;
  if (next === null) return prev + RANK_STEP;

  const mid = prev + (next - prev) / 2;
  return prev < mid && mid < next ? mid : null;
}

/**
 * 現在の順序を保ったまま `RANK_STEP` 刻みで振り直す。
 *
 * 振り直した値はエポックミリ秒よりはるかに小さいので、その後に作られた
 * `rank` の無いカードも末尾に付く。
 */
export function rebalance(items: readonly Rankable[]): Map<string, number> {
  const sorted = [...items].sort(compareCards);
  return new Map(sorted.map((item, index) => [item.id, (index + 1) * RANK_STEP]));
}

/**
 * `targetId` を直前 `prev`・直後 `next` の間へ動かすときに書き換える値（項目の ID → 新しい rank）。
 *
 * 隙間があれば動かす項目 1 つだけになる。隙間が尽きたときに限り、残りの項目を
 * 振り直した上で差し込み、値が変わる項目をすべて返す。`items` に `targetId` が
 * 含まれていなくてもよい（まだ位置を持たない区切り線を初めて置くとき）。
 */
export function planMove(
  items: readonly Rankable[],
  targetId: string,
  prev: Rankable | null,
  next: Rankable | null
): Map<string, number> {
  const rank = rankBetween(
    prev === null ? null : effectiveRank(prev),
    next === null ? null : effectiveRank(next)
  );
  if (rank !== null) return new Map([[targetId, rank]]);

  const others = items.filter((item) => item.id !== targetId);
  const ranks = rebalance(others);
  const rankOf = (item: Rankable | null): number | null =>
    item === null ? null : (ranks.get(item.id) as number);

  // 振り直し後は隣どうしの間に必ず RANK_STEP 以上の隙間がある
  const updates = new Map([[targetId, rankBetween(rankOf(prev), rankOf(next)) as number]]);

  for (const item of others) {
    const rebalanced = ranks.get(item.id) as number;
    // 振り直しても値が変わらない項目は書かない
    if (rebalanced !== item.rank) updates.set(item.id, rebalanced);
  }

  return updates;
}
