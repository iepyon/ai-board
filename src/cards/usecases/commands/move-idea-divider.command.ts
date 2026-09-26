import { ok, type Result } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import { DIVIDER_ID } from '../../../shared/card-reorder.js';
import type { MoveCardError } from '../../errors/card-errors.js';
import { moveInOrder, type OrderRepositories } from './move-in-order.js';

// ============================================================
// 区切り線の移動ユースケース
// ============================================================

export interface MoveIdeaDividerInput {
  /** 移動先で直前に来るカード。null なら列の先頭 */
  readonly after: CardId | null;
  /** 移動先で直後に来るカード。null なら列の末尾 */
  readonly before: CardId | null;
}

export interface IdeaDividerPosition {
  /** 区切り線の rank。まだ一度も置かれていなければ null */
  readonly rank: number | null;
}

export type MoveIdeaDividerCommand = (
  input: MoveIdeaDividerInput
) => Promise<Result<IdeaDividerPosition, MoveCardError>>;

/**
 * 区切り線を直前・直後のカードの間へ動かす。まだ位置が無ければ、ここで初めて行が作られる。
 * 並べ替えの規則はカードと同じ（`moveInOrder`）。
 */
export function createMoveIdeaDividerCommand(
  repositories: OrderRepositories
): MoveIdeaDividerCommand {
  return async ({ after, before }) => {
    const moved = await moveInOrder(repositories, DIVIDER_ID, after, before);
    if (!moved.ok) return moved;

    return ok({ rank: await repositories.divider.get() });
  };
}
