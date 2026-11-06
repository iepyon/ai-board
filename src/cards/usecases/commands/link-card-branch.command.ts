import { ok, err, type Result } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { Card } from '../../models/card.js';
import type { CardRepository } from '../../repositories/card.repository.js';
import type { UpdateCardError } from '../../errors/card-errors.js';

// ============================================================
// ブランチの紐付けユースケース
// ============================================================

export interface LinkCardBranchInput {
  readonly id: CardId;
  /** 紐付けるブランチの名前。null なら紐付けを外す */
  readonly branch: string | null;
}

export type LinkCardBranchCommand = (
  input: LinkCardBranchInput
) => Promise<Result<Card, UpdateCardError>>;

/**
 * カードの `branch` だけを書き換える。AI が書いてよい frontmatter の項目はこれだけで、
 * `startedAt` / `skipGates` / `rank`（人の判断）はこの口からは書けない。
 */
export function createLinkCardBranchCommand(cardRepository: CardRepository): LinkCardBranchCommand {
  return async ({ id, branch }) => {
    const existing = await cardRepository.findById(id);
    if (!existing) {
      return err({ type: 'CardNotFound', id });
    }

    const updated: Card = { ...existing, branch };
    if (!(await cardRepository.save(updated))) {
      return err({ type: 'CardNotFound', id });
    }

    return ok(updated);
  };
}
