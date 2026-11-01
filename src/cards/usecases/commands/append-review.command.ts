import { ok, err, type Result } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { Card } from '../../models/card.js';
import type { ReviewGate, ReviewKind } from '../../models/review.js';
import { appendReviewEntry, findEntryHeadingLine } from '../../services/review-log.js';
import type { CardRepository } from '../../repositories/card.repository.js';
import type { AppendReviewError } from '../../errors/card-errors.js';

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
) => Promise<Result<Card, AppendReviewError>>;

/**
 * 人の判断をカード本文へ追記する。
 *
 * ステージは書かない。追記されたログを `resolveStage` が読み、
 * 次の `GET /api/board` で列が変わる。
 *
 * 理由に判断の見出しとして読める行があれば、書かずに `ReasonHasEntryHeading` を返す。
 * 理由は見出しの下にそのまま書かれるので、その行が別の判断として読まれてしまう。
 * CLI と API のどちらから書いてもここを通るので、入口ごとに検査を持たない。
 */
export function createAppendReviewCommand(cardRepository: CardRepository): AppendReviewCommand {
  return async ({ id, gate, kind, reason, at }) => {
    const existing = await cardRepository.findById(id);
    if (!existing) {
      return err({ type: 'CardNotFound', id });
    }

    const trimmed = reason.trim();
    const heading = findEntryHeadingLine(trimmed);
    if (heading !== null) {
      return err({ type: 'ReasonHasEntryHeading', line: heading });
    }

    const updated: Card = {
      ...existing,
      body: appendReviewEntry(existing.body, {
        at: at.toISOString(),
        gate,
        kind,
        reason: trimmed,
      }),
    };

    const saved = await cardRepository.save(updated);
    if (!saved) {
      return err({ type: 'CardNotFound', id });
    }

    return ok(updated);
  };
}
