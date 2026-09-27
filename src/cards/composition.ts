import type { DatabaseSync } from 'node:sqlite';
import type { CardRepository } from './repositories/card.repository.js';
import { SqliteCardRepository } from './repositories/sqlite-card.repository.js';
import type { IdeaDividerRepository } from './repositories/idea-divider.repository.js';
import { SqliteIdeaDividerRepository } from './repositories/sqlite-idea-divider.repository.js';
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
import {
  createMoveIdeaDividerCommand,
  type MoveIdeaDividerCommand,
} from './usecases/commands/move-idea-divider.command.js';
import { FsChangeFileRepository } from './repositories/fs-change-file.repository.js';
import { SqliteAppliedChangeRepository } from './repositories/sqlite-applied-change.repository.js';
import {
  createRecordChangesCommand,
  type RecordChangesCommand,
} from './usecases/commands/record-changes.command.js';
import {
  createApplyChangesCommand,
  type ApplyChangesCommand,
} from './usecases/commands/apply-changes.command.js';

// ============================================================
// Cards コンテキスト 依存性構成
// ============================================================

export interface CardDependencies {
  readonly cardRepository: CardRepository;
  readonly ideaDividerRepository: IdeaDividerRepository;
  readonly createCardCommand: CreateCardCommand;
  readonly updateCardMetaCommand: UpdateCardMetaCommand;
  readonly updateCardBodyCommand: UpdateCardBodyCommand;
  readonly appendReviewCommand: AppendReviewCommand;
  readonly moveCardCommand: MoveCardCommand;
  readonly moveIdeaDividerCommand: MoveIdeaDividerCommand;
}

/** `onWrite` はサーバ自身の書き込みの後に呼ばれる（SSE で画面へ知らせるため） */
export function createCardDependencies(db: DatabaseSync, onWrite?: () => void): CardDependencies {
  const cardRepository = new SqliteCardRepository(db, onWrite);
  const ideaDividerRepository = new SqliteIdeaDividerRepository(db, onWrite);
  const order = { cards: cardRepository, divider: ideaDividerRepository };

  return {
    cardRepository,
    ideaDividerRepository,
    createCardCommand: createCreateCardCommand(cardRepository),
    updateCardMetaCommand: createUpdateCardMetaCommand(cardRepository),
    updateCardBodyCommand: createUpdateCardBodyCommand(cardRepository),
    appendReviewCommand: createAppendReviewCommand(cardRepository),
    moveCardCommand: createMoveCardCommand(order),
    moveIdeaDividerCommand: createMoveIdeaDividerCommand(order),
  };
}

export interface ChangeDependencies {
  readonly recordChangesCommand: RecordChangesCommand;
  readonly applyChangesCommand: ApplyChangesCommand;
}

/**
 * データのマイグレーション（`.ai-board/changes/`）の依存。
 * カードの書き込みは `cards` のリポジトリを通すので、サーバなら SSE への通知もそのまま届く。
 */
export function createChangeDependencies(
  db: DatabaseSync,
  changesDir: string,
  cards: CardDependencies
): ChangeDependencies {
  const repositories = {
    cards: cards.cardRepository,
    divider: cards.ideaDividerRepository,
    files: new FsChangeFileRepository(changesDir),
    applied: new SqliteAppliedChangeRepository(db),
  };

  return {
    recordChangesCommand: createRecordChangesCommand(repositories),
    applyChangesCommand: createApplyChangesCommand(repositories),
  };
}
