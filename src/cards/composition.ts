import type { DatabaseSync } from 'node:sqlite';
import type { CardRepository } from './repositories/card.repository.js';
import { SqliteCardRepository } from './repositories/sqlite-card.repository.js';
import {
  createCreateCardCommand,
  type CreateCardCommand,
} from './usecases/commands/create-card.command.js';
import {
  createUpdateCardMetaCommand,
  type UpdateCardMetaCommand,
} from './usecases/commands/update-card-meta.command.js';
import {
  createUpdateCardBodyCommand,
  type UpdateCardBodyCommand,
} from './usecases/commands/update-card-body.command.js';
import {
  createAppendReviewCommand,
  type AppendReviewCommand,
} from './usecases/commands/append-review.command.js';

import {
  createMoveCardCommand,
  type MoveCardCommand,
} from './usecases/commands/move-card.command.js';

// ============================================================
// Cards コンテキスト 依存性構成
// ============================================================

export interface CardDependencies {
  readonly cardRepository: CardRepository;
  readonly createCardCommand: CreateCardCommand;
  readonly updateCardMetaCommand: UpdateCardMetaCommand;
  readonly updateCardBodyCommand: UpdateCardBodyCommand;
  readonly appendReviewCommand: AppendReviewCommand;
  readonly moveCardCommand: MoveCardCommand;
}

/** `onWrite` はサーバ自身の書き込みの後に呼ばれる（SSE で画面へ知らせるため） */
export function createCardDependencies(db: DatabaseSync, onWrite?: () => void): CardDependencies {
  const cardRepository = new SqliteCardRepository(db, onWrite);

  return {
    cardRepository,
    createCardCommand: createCreateCardCommand(cardRepository),
    updateCardMetaCommand: createUpdateCardMetaCommand(cardRepository),
    updateCardBodyCommand: createUpdateCardBodyCommand(cardRepository),
    appendReviewCommand: createAppendReviewCommand(cardRepository),
    moveCardCommand: createMoveCardCommand(cardRepository),
  };
}
