import { ok, err, type Result } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { Card } from '../../models/card.js';
import type { ReviewGate, ReviewKind } from '../../models/review.js';
import { appendReviewEntry } from '../../services/review-log.js';
import type { CardRepository } from '../../repositories/card.repository.js';
import type { UpdateCardError } from '../../errors/card-errors.js';

// ============================================================
// レビュー追記ユースケース
// ============================================================

export interface AppendReviewCommandInput {
  readonly id: CardId;
  readonly gate: ReviewGate;
  readonly kind: ReviewKind;
  readonly reason: string;
  readonly at: Date;
}

export type AppendReviewCommand = (
  input: AppendReviewCommandInput
) => Promise<Result<Card, UpdateCardError>>;

/**
 * 人の判断をカード本文へ追記する。
 *
 * ステージは書かない。追記されたログを `resolveStage` が読み、
 * 次の `GET /api/board` で列が変わる。
 */
export function createAppendReviewCommand(cardRepository: CardRepository): AppendReviewCommand {
  return async ({ id, gate, kind, reason, at }) => {
    const existing = await cardRepository.findById(id);
    if (!existing) {
      return err({ type: 'CardNotFound', id });
    }

    const updated: Card = {
      ...existing,
      body: appendReviewEntry(existing.body, {
        at: at.toISOString(),
        gate,
        kind,
        reason: reason.trim(),
      }),
    };

    const saved = await cardRepository.save(updated);
    if (!saved) {
      return err({ type: 'CardNotFound', id });
    }

    return ok(updated);
  };
}
