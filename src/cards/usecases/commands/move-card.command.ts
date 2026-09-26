import { ok, type Result } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { Card } from '../../models/card.js';
import type { MoveCardError } from '../../errors/card-errors.js';
import { moveInOrder, type OrderRef, type OrderRepositories } from './move-in-order.js';

// ============================================================
// カード並べ替えユースケース
// ============================================================

export interface MoveCardInput {
  readonly id: CardId;
  /** 移動先で直前に来るカードか区切り線。null なら列の先頭 */
  readonly after: OrderRef | null;
  /** 移動先で直後に来るカードか区切り線。null なら列の末尾 */
  readonly before: OrderRef | null;
}

export type MoveCardCommand = (input: MoveCardInput) => Promise<Result<Card, MoveCardError>>;

/**
 * 直前・直後の項目の間へ動かす。
 *
 * 列内の隣どうしの間に差し込めば、その列の相対順だけが変わり、他の列の相対順は変わらない。
 * 書き換えるのは原則として動かしたカード 1 枚だけ。隙間が尽きたときに限り、
 * 全カードと区切り線を振り直して複数の行を書く。
 */
export function createMoveCardCommand(repositories: OrderRepositories): MoveCardCommand {
  return async ({ id, after, before }) => {
    const moved = await moveInOrder(repositories, id, after, before);
    if (!moved.ok) return moved;

    // 対象の存在は moveInOrder が確かめている
    const card = (await repositories.cards.findById(id)) as Card;
    return ok(card);
  };
}
