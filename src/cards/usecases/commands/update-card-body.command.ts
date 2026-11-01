import { isDeepStrictEqual } from 'node:util';
import { ok, err, type Result } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { Card } from '../../models/card.js';
import { parseReviewLog } from '../../services/review-log.js';
import type { CardRepository } from '../../repositories/card.repository.js';
import type { UpdateCardBodyError } from '../../errors/card-errors.js';

// ============================================================
// カード本文更新ユースケース
// ============================================================

export interface UpdateCardBodyInput {
  readonly id: CardId;
  readonly body: string;
}

export type UpdateCardBodyCommand = (
  input: UpdateCardBodyInput
) => Promise<Result<Card, UpdateCardBodyError>>;

/**
 * カードの本文を差し替える。
 *
 * `## レビュー` のエントリ（`parseReviewLog` で読んだもの）が今と変わる本文は、書かずに `ReviewEntriesChanged` を返す。
 * 判断は追記の usecase（`createAppendReviewCommand`）から、リポジトリの `appendReview` に値のまま渡してだけ足す。
 * 本文の差し替えでは判断を足させない。人に「判断は判断のボタンから足す」と返す `ReviewEntriesChanged` は、
 * リポジトリの拒否（`CardWriteRefused`）より手前のここで返す。
 * CLI と API のどちらから書いてもここを通るので、入口ごとに検査を持たない。
 *
 * 本文の途中に偽の `## レビュー` 節を書いても、`parseReviewLog` は最初の節を読むので、エントリがあれば食い違って拒まれる。
 * エントリが無ければ食い違わず、保存時にその節は消える（`stripReviewSection`）。
 */
export function createUpdateCardBodyCommand(cardRepository: CardRepository): UpdateCardBodyCommand {
  return async ({ id, body }) => {
    const existing = await cardRepository.findById(id);
    if (!existing) {
      return err({ type: 'CardNotFound', id });
    }

    if (!isDeepStrictEqual(parseReviewLog(existing.body), parseReviewLog(body))) {
      return err({ type: 'ReviewEntriesChanged', id });
    }

    const updated: Card = { ...existing, body };

    const saved = await cardRepository.save(updated);
    if (!saved) {
      return err({ type: 'CardNotFound', id });
    }

    return ok(updated);
  };
}
