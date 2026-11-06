import { err, type Result } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { Card } from '../../models/card.js';
import type { ReviewGate } from '../../models/review.js';
import type { CardRepository } from '../../repositories/card.repository.js';
import type { SubmitReviewError } from '../../errors/card-errors.js';
import { gateStates, parseReviewLog } from '../../services/review-log.js';
import { createAppendReviewCommand } from './append-review.command.js';

// ============================================================
// 提出ユースケース — AI の手の区切りを 提出 / 再提出 として残す
// ============================================================

export interface SubmitReviewCommandInput {
  readonly id: CardId;
  readonly gate: ReviewGate;
  /** true なら 再提出、false なら 提出 */
  readonly resubmit: boolean;
  readonly reason: string;
  readonly at: Date;
}

export type SubmitReviewCommand = (
  input: SubmitReviewCommandInput
) => Promise<Result<Card, SubmitReviewError>>;

/**
 * AI の手の区切りを `提出` / `再提出` として残す。
 *
 * 種別は `resubmit` から決め、入力に持たない。承認 / 否決 / 中止は、この usecase からは書けない。
 *
 * 提出（再提出を含む）は、人が着手したカードにだけ書ける。plan を飛ばす宣言のあるカードでは
 * 提出がそのまま承認と読まれるので、着手していないカードに書けると、人の着手を経ずにアイデアから
 * 実装中へ進めてしまう。宣言の有無で分けないのは、宣言の無いカードでも着手していないカードに
 * AI が計画を出す道は無く、振る舞いの上で失うものが無いためである。
 *
 * 提出は、さらにゲートが未提出（`none`）か否決（`rejected`）のときにだけ書ける。
 * 提出済み・承認済み・保留のカードに書けると、plan を飛ばす宣言のあるカードでは `plan 再提出` が承認と
 * 同じに読まれ、人の否決や保留を経ずに計画を出し直せてしまう。
 * 宣言の無いカードでも、否決を受けずに計画を出し直す手は無いので、宣言の有無で分けない。
 */
export function createSubmitReviewCommand(cardRepository: CardRepository): SubmitReviewCommand {
  const appendReview = createAppendReviewCommand(cardRepository);

  return async ({ id, gate, resubmit, reason, at }) => {
    const card = await cardRepository.findById(id);
    if (card === null) return err({ type: 'CardNotFound', id });

    if (card.startedAt === null) return err({ type: 'SubmitBeforeStart', id });

    const state = gateStates(parseReviewLog(card.body), card.skipGates)[gate];
    if (state !== 'none' && state !== 'rejected') {
      return err({ type: 'SubmitGateClosed', id, gate, state });
    }

    return appendReview({ id, gate, kind: resubmit ? '再提出' : '提出', reason, at });
  };
}
