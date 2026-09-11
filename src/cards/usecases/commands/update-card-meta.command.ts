import { ok, err, type Result } from '../../../shared/result.js';
import type { CardId, ChangeName, MergeRequestIid } from '../../../shared/schemas/common.js';
import type { ReviewGate } from '../../models/review.js';
import type { Card } from '../../models/card.js';
import type { CardRepository } from '../../repositories/card.repository.js';
import type { UpdateCardError } from '../../errors/card-errors.js';

// ============================================================
// カード frontmatter 更新ユースケース
// ============================================================

/**
 * 部分更新のパッチ。
 *
 * `undefined` は「変更しない」、`null` は「値を消す」を意味する。
 * この 2 つを混同すると、着手の取り消しや change の紐付け解除ができなくなる。
 */
export interface UpdateCardMetaPatch {
  readonly title?: string | undefined;
  readonly startedAt?: string | null | undefined;
  readonly skipGates?: readonly ReviewGate[] | undefined;
  readonly change?: string | null | undefined;
  readonly branch?: string | null | undefined;
  readonly mr?: number | null | undefined;
}

export interface UpdateCardMetaInput {
  readonly id: CardId;
  readonly patch: UpdateCardMetaPatch;
}

export type UpdateCardMetaCommand = (
  input: UpdateCardMetaInput
) => Promise<Result<Card, UpdateCardError>>;

export function createUpdateCardMetaCommand(cardRepository: CardRepository): UpdateCardMetaCommand {
  return async ({ id, patch }) => {
    const existing = await cardRepository.findById(id);
    if (!existing) {
      return err({ type: 'CardNotFound', id });
    }

    const updated: Card = {
      ...existing,
      title: patch.title ?? existing.title,
      startedAt: pick(patch.startedAt, existing.startedAt),
      skipGates: patch.skipGates ?? existing.skipGates,
      change: pick(patch.change, existing.change) as ChangeName | null,
      branch: pick(patch.branch, existing.branch),
      mr: pick(patch.mr, existing.mr) as MergeRequestIid | null,
    };

    const saved = await cardRepository.save(updated);
    if (!saved) {
      return err({ type: 'CardNotFound', id });
    }

    return ok(updated);
  };
}

/** undefined は現在値を維持し、null は明示的な消去として扱う */
function pick<T>(patched: T | null | undefined, current: T | null): T | null {
  return patched === undefined ? current : patched;
}
