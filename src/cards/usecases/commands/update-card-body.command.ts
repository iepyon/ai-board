import { ok, err, type Result } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { Card } from '../../models/card.js';
import type { CardRepository } from '../../repositories/card.repository.js';
import type { UpdateCardError } from '../../errors/card-errors.js';

// ============================================================
// カード本文更新ユースケース
// ============================================================

export interface UpdateCardBodyInput {
  readonly id: CardId;
  readonly body: string;
}

export type UpdateCardBodyCommand = (
  input: UpdateCardBodyInput
) => Promise<Result<Card, UpdateCardError>>;

export function createUpdateCardBodyCommand(cardRepository: CardRepository): UpdateCardBodyCommand {
  return async ({ id, body }) => {
    const existing = await cardRepository.findById(id);
    if (!existing) {
      return err({ type: 'CardNotFound', id });
    }

    const updated: Card = { ...existing, body };

    const saved = await cardRepository.save(updated);
    if (!saved) {
      return err({ type: 'CardNotFound', id });
    }

    return ok(updated);
  };
}
