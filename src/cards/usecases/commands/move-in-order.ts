import { ok, err, type Result } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import { DIVIDER_ID } from '../../../shared/card-reorder.js';
import type { Card } from '../../models/card.js';
import type { CardRepository } from '../../repositories/card.repository.js';
import type { IdeaDividerRepository } from '../../repositories/idea-divider.repository.js';
import type { MoveCardError } from '../../errors/card-errors.js';
import {
  compareCards,
  effectiveRank,
  planMove,
  rankBetween,
  type Rankable,
} from '../../services/card-order.js';

// ============================================================
// 並びの中での移動 — カードの並べ替えと区切り線の移動が共有する
// ============================================================

/** 並びの項目を指す値。カード ID か、区切り線を指す `DIVIDER_ID` */
export type OrderRef = CardId | typeof DIVIDER_ID;

export interface OrderRepositories {
  readonly cards: CardRepository;
  readonly divider: IdeaDividerRepository;
}

/** 区切り線の `created` は使われない（`rank` を必ず持つ）。型を満たすための値 */
const DIVIDER_CREATED = new Date(0).toISOString();

/**
 * `target` を直前 `after`・直後 `before` の間へ動かし、書き換えた値（ID → rank）を返す。
 *
 * 並び順は全カードと区切り線で 1 本で、列（アイデアの表など）はその部分列にすぎない。
 * 区切り線はカードと同じ 1 項目として並びに入れるので、ここに区切り線だけの分岐は無い。
 * まだ位置を持たない区切り線は画面では末尾に見えているので、隣に指定されたら末尾に置いてから動かす。
 */
export async function moveInOrder(
  repositories: OrderRepositories,
  target: OrderRef,
  after: OrderRef | null,
  before: OrderRef | null
): Promise<Result<Map<string, number>, MoveCardError>> {
  const cards = await repositories.cards.findAll();
  const divider = await dividerRank(repositories, cards, [after, before].includes(DIVIDER_ID));

  const items: Rankable[] = [...cards];
  if (divider !== null) items.push({ id: DIVIDER_ID, rank: divider, created: DIVIDER_CREATED });
  items.sort(compareCards);

  const byId = new Map<string, Rankable>(items.map((item) => [item.id, item]));
  if (target !== DIVIDER_ID && !byId.has(target)) return err({ type: 'CardNotFound', id: target });

  const prev = resolveNeighbor(byId, after);
  if (!prev.ok) return prev;
  const next = resolveNeighbor(byId, before);
  if (!next.ok) return next;

  if (prev.value !== null && next.value !== null && compareCards(prev.value, next.value) >= 0) {
    return err({ type: 'StaleOrder', after: prev.value.id, before: next.value.id });
  }
  if (prev.value === null && next.value === null) return ok(new Map());

  const updates = planMove(items, target, prev.value, next.value);
  const written = await write(repositories, cards, updates);
  if (!written.has(target)) return err({ type: 'CardNotFound', id: target });

  return ok(written);
}

/**
 * 区切り線の rank。未設定で、隣に指定されている（`materialize`）ときは
 * 画面で見えている位置＝全カードの末尾に置いて書く。
 */
async function dividerRank(
  repositories: OrderRepositories,
  cards: readonly Card[],
  materialize: boolean
): Promise<number | null> {
  const current = await repositories.divider.get();
  if (current !== null || !materialize) return current;

  const last = cards.reduce<number | null>(
    (max, card) => Math.max(max ?? -Infinity, effectiveRank(card)),
    null
  );
  const rank = rankBetween(last, null) as number;
  await repositories.divider.set(rank);

  return rank;
}

function resolveNeighbor(
  byId: ReadonlyMap<string, Rankable>,
  ref: OrderRef | null
): Result<Rankable | null, MoveCardError> {
  if (ref === null) return ok(null);

  const item = byId.get(ref);
  return item !== undefined ? ok(item) : err({ type: 'CardNotFound', id: ref });
}

/** 書けた値だけを返す（書く間に消えたカードは落ちる） */
async function write(
  repositories: OrderRepositories,
  cards: readonly Card[],
  updates: ReadonlyMap<string, number>
): Promise<Map<string, number>> {
  const cardById = new Map<string, Card>(cards.map((card) => [card.id, card]));
  const written = new Map<string, number>();

  for (const [id, rank] of updates) {
    if (id === DIVIDER_ID) {
      await repositories.divider.set(rank);
      written.set(id, rank);
      continue;
    }

    const card = cardById.get(id);
    if (card !== undefined && (await repositories.cards.save({ ...card, rank }))) {
      written.set(id, rank);
    }
  }

  return written;
}
