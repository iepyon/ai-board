import { ok, err, type Result } from '../../../shared/result.js';
import { CardIdSchema, slugify, type CardId } from '../../../shared/schemas/common.js';
import type { Card } from '../../models/card.js';
import type { CardRepository } from '../../repositories/card.repository.js';
import type { CreateCardError } from '../../errors/card-errors.js';

// ============================================================
// カード作成ユースケース
// ============================================================

export interface CreateCardInput {
  readonly title: string;
  /** 省略時は title から slug を生成する */
  readonly id?: string | undefined;
  readonly body?: string | undefined;
  readonly createdAt: Date;
}

export type CreateCardCommand = (input: CreateCardInput) => Promise<Result<Card, CreateCardError>>;

export function createCreateCardCommand(cardRepository: CardRepository): CreateCardCommand {
  return async (input) => {
    const idResult = resolveCardId(input);
    if (!idResult.ok) {
      return idResult;
    }

    const card: Card = {
      id: idResult.value,
      title: input.title,
      created: input.createdAt.toISOString(),
      startedAt: null,
      skipGates: [],
      branch: null,
      mr: null,
      forge: null,
      body: input.body ?? '',
    };

    const created = await cardRepository.create(card);
    if (!created) {
      return err({ type: 'DuplicateCardId', id: card.id });
    }

    return ok(card);
  };
}

/**
 * 明示指定があればそれを検証し、無ければタイトルから slug を作る。
 *
 * 日本語だけのタイトルは slug 化すると空になるため、その場合は
 * id を明示するようユーザーに促す。
 */
function resolveCardId(input: CreateCardInput): Result<CardId, CreateCardError> {
  if (input.id !== undefined) {
    const parsed = CardIdSchema.safeParse(input.id);
    if (!parsed.success) {
      return err({
        type: 'InvalidCardId',
        reason: parsed.error.issues.map((issue) => issue.message).join(', '),
      });
    }
    return ok(parsed.data as CardId);
  }

  const slug = slugify(input.title);
  if (slug === null) {
    return err({
      type: 'InvalidCardId',
      reason: 'タイトルから ID を生成できませんでした。id を明示的に指定してください。',
    });
  }

  return ok(slug as CardId);
}
