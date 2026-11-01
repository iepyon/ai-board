import { ok, err, type Result } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { Card } from '../../models/card.js';
import type { ReviewGate, ReviewKind } from '../../models/review.js';
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
 * 人の判断を 1 件、カードに足す。
 *
 * ステージは書かない。足した判断を `resolveStage` が読み、
 * 次の `GET /api/board` で列が変わる。
 *
 * 判断は値のままリポジトリの `appendReview` に渡し、本文の文字列を経由しない。
 * 理由に判断の見出し（`### <時刻> <gate> <種別>`）の形の行があっても、理由の一部として記録されるだけで、
 * 判断は指定した 1 件だけが増える（組み立てた本文では `####` へ下がって見える）。
 * 応答には、書いた後に読み直して組み立てたカードを返す。
 */
export function createAppendReviewCommand(cardRepository: CardRepository): AppendReviewCommand {
  return async ({ id, gate, kind, reason, at }) => {
    const appended = await cardRepository.appendReview(id, {
      at: at.toISOString(),
      gate,
      kind,
      reason: reason.trim(),
    });
    if (!appended) {
      return err({ type: 'CardNotFound', id });
    }

    const updated = await cardRepository.findById(id);
    if (!updated) {
      return err({ type: 'CardNotFound', id });
    }

    return ok(updated);
  };
}
