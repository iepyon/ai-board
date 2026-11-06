import { isDeepStrictEqual } from 'node:util';
import { ok, err, type Result } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { Card } from '../../models/card.js';
import { hasReviewSection, parseReviewLog } from '../../services/review-log.js';
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
 * - `## レビュー` の節を持たない本文（`card body` に本文だけを送る形）は、判断は変えないと読んで本文だけを書く。
 *   判断は `log/` にあり、本文の保存はそこに触らないので、節が無くても判断は消えない
 * - 節を持つ本文（CLI で `card show` の出力を直して送る形）は、そのエントリ（`parseReviewLog` で読んだもの）が
 *   今と変わるなら、書かずに `ReviewEntriesChanged` を返す。同じなら節を除いて本文を書く
 *
 * 判断は追記の usecase（`createAppendReviewCommand`）から、リポジトリの `appendReview` に値のまま渡してだけ足す。
 * 本文の差し替えでは判断を足させない。人に「判断は判断の入口から足す」と返す `ReviewEntriesChanged` は、
 * リポジトリの拒否（`CardWriteRefused`）より手前のここで返す。
 * どの CLI（`card body` など）から書いてもここを通るので、入口ごとに検査を持たない。
 *
 * 本文の途中に偽の `## レビュー` 節を書いても、`parseReviewLog` は最初の節を読むので、エントリがあれば食い違って拒まれる。
 * エントリが無ければ食い違わず、保存時にその節は消える（`stripReviewSection`）。
 *
 * 保存した後は `findById` で読み直して返す。節の無い本文から作った `Card` をそのまま返すと、判断の無いカードに見えるため。
 */
export function createUpdateCardBodyCommand(cardRepository: CardRepository): UpdateCardBodyCommand {
  return async ({ id, body }) => {
    const existing = await cardRepository.findById(id);
    if (!existing) {
      return err({ type: 'CardNotFound', id });
    }

    if (
      hasReviewSection(body) &&
      !isDeepStrictEqual(parseReviewLog(existing.body), parseReviewLog(body))
    ) {
      return err({ type: 'ReviewEntriesChanged', id });
    }

    const updated: Card = { ...existing, body };

    const saved = await cardRepository.save(updated);
    if (!saved) {
      return err({ type: 'CardNotFound', id });
    }

    const reread = await cardRepository.findById(id);
    if (!reread) {
      return err({ type: 'CardNotFound', id });
    }

    return ok(reread);
  };
}
