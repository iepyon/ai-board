import { ok, err, type Result } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { Card } from '../../models/card.js';
import type { CardRepository } from '../../repositories/card.repository.js';
import type { MoveCardError } from '../../errors/card-errors.js';
import { compareCards, effectiveRank, rankBetween, rebalance } from '../../services/card-order.js';

// ============================================================
// カード並べ替えユースケース
// ============================================================

export interface MoveCardInput {
  readonly id: CardId;
  /** 移動先で直前に来るカード。null なら列の先頭 */
  readonly after: CardId | null;
  /** 移動先で直後に来るカード。null なら列の末尾 */
  readonly before: CardId | null;
}

export type MoveCardCommand = (input: MoveCardInput) => Promise<Result<Card, MoveCardError>>;

interface Neighbors {
  readonly after: Card | null;
  readonly before: Card | null;
}

/**
 * 直前・直後のカードの間へ動かす。
 *
 * 並び順は全カードで 1 本で、列はその部分列にすぎない。列内の隣どうしの間に
 * 差し込めば、その列の相対順だけが変わり、他の列の相対順は変わらない。
 *
 * 書き換えるのは原則として動かしたカード 1 枚だけ。隙間が尽きたときに限り、
 * 全カードを振り直して複数のファイルを書く。
 */
export function createMoveCardCommand(cardRepository: CardRepository): MoveCardCommand {
  return async ({ id, after, before }) => {
    const cards = (await cardRepository.findAll()).sort(compareCards);
    const byId = new Map<string, Card>(cards.map((card) => [card.id, card]));

    const target = byId.get(id);
    if (target === undefined) return err({ type: 'CardNotFound', id });

    const neighbors = resolveNeighbors(byId, after, before);
    if (!neighbors.ok) return neighbors;

    const { after: prev, before: next } = neighbors.value;
    if (prev === null && next === null) return ok(target);

    const updates = planUpdates(cards, target, prev, next);

    for (const card of updates) {
      const saved = await cardRepository.save(card);
      if (!saved && card.id === id) return err({ type: 'CardNotFound', id });
    }

    return ok(updates.find((card) => card.id === id) ?? target);
  };
}

function resolveNeighbors(
  byId: ReadonlyMap<string, Card>,
  afterId: CardId | null,
  beforeId: CardId | null
): Result<Neighbors, MoveCardError> {
  const after = afterId === null ? null : byId.get(afterId);
  if (after === undefined) return err({ type: 'CardNotFound', id: afterId as CardId });

  const before = beforeId === null ? null : byId.get(beforeId);
  if (before === undefined) return err({ type: 'CardNotFound', id: beforeId as CardId });

  if (after !== null && before !== null && compareCards(after, before) >= 0) {
    return err({ type: 'StaleOrder', after: after.id, before: before.id });
  }

  return ok({ after, before });
}

/** 書き換えるカードの一覧。隙間があれば動かしたカードだけになる */
function planUpdates(
  cards: readonly Card[],
  target: Card,
  prev: Card | null,
  next: Card | null
): Card[] {
  const rank = rankBetween(
    prev === null ? null : effectiveRank(prev),
    next === null ? null : effectiveRank(next)
  );
  if (rank !== null) return [{ ...target, rank }];

  const ranks = rebalance(cards);
  const rankOf = (card: Card | null): number | null =>
    card === null ? null : (ranks.get(card.id) as number);

  // 振り直し後は隣どうしの間に必ず RANK_STEP 以上の隙間がある
  const moved = rankBetween(rankOf(prev), rankOf(next)) as number;

  return cards.flatMap((card) => {
    const rank = card.id === target.id ? moved : (ranks.get(card.id) as number);
    // 振り直しても値が変わらないカードは書かない
    return rank === card.rank ? [] : [{ ...card, rank }];
  });
}
