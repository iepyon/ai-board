import { err, type Result } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { Card } from '../../models/card.js';
import type { ReviewGate } from '../../models/review.js';
import type { CardRepository } from '../../repositories/card.repository.js';
import type { HoldReviewError } from '../../errors/card-errors.js';
import { gateStates, parseReviewLog } from '../../services/review-log.js';
import { createAppendReviewCommand } from './append-review.command.js';

// ============================================================
// 保留ユースケース — AI が手を進められずに止まったことを残す
// ============================================================

export interface HoldReviewCommandInput {
  readonly id: CardId;
  readonly gate: ReviewGate;
  readonly reason: string;
  readonly at: Date;
}

export type HoldReviewCommand = (
  input: HoldReviewCommandInput
) => Promise<Result<Card, HoldReviewError>>;

/**
 * AI が手を進められずに止まったことを `保留` として残す。種別は `保留` に固定する。
 *
 * 保留はゲートを先へ進めない（どの規則も `held` で前へ進まない）。人が後から承認 / 否決 / 中止を書けば
 * それがゲートの最新エントリになり、保留は自然に外れる。
 *
 * 書けるのは、そのゲートの最新の判断が 否決 のときだけにする。AI が保留を書くのは否決を直す手
 * （`revise-plan`）で止まるときだけで、それ以外で書けると、承認済みの plan に保留を書いて
 * 人の承認を打ち消したり、計画レビューで人を待つカードを AI の列へ落としたりできてしまう。
 *
 * 理由が要ることは、呼び出し側（`ai-board card hold` の引数の検査）が確かめる。
 */
export function createHoldReviewCommand(cardRepository: CardRepository): HoldReviewCommand {
  const appendReview = createAppendReviewCommand(cardRepository);

  return async ({ id, gate, reason, at }) => {
    const card = await cardRepository.findById(id);
    if (card === null) return err({ type: 'CardNotFound', id });

    const state = gateStates(parseReviewLog(card.body), card.skipGates)[gate];
    if (state !== 'rejected') return err({ type: 'HoldGateNotRejected', id, gate, state });

    return appendReview({ id, gate, kind: '保留', reason, at });
  };
}
