import type { DatabaseSync } from 'node:sqlite';
import type { BoardPaths } from '../shared/config.js';
import type { CliRunner } from '../infrastructure/cli-runner.js';
import { createDataStore, type DataStore } from '../infrastructure/data-store.js';
import type { CardRepository } from './repositories/card.repository.js';
import { SqliteCardRepository } from './repositories/sqlite-card.repository.js';
import type { IdeaDividerRepository } from './repositories/idea-divider.repository.js';
import { SqliteIdeaDividerRepository } from './repositories/sqlite-idea-divider.repository.js';
import { FileCardRepository } from './repositories/file-card.repository.js';
import { FileIdeaDividerRepository } from './repositories/file-idea-divider.repository.js';
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
  return assemble(
    new SqliteCardRepository(db, onWrite),
    new SqliteIdeaDividerRepository(db, onWrite)
  );
}

/**
 * データのワークツリーのファイルでカードを読み書きする。
 *
 * リポジトリはコミットと push を持たない。書き込みの usecase は `DataStore.transact` の中で呼ぶ。
 */
export function createFileCardDependencies(
  dataDir: string,
  onWrite?: () => void
): CardDependencies {
  return assemble(
    new FileCardRepository(dataDir, onWrite === undefined ? {} : { onWrite }),
    new FileIdeaDividerRepository(dataDir, onWrite)
  );
}

/**
 * 設定の置き場所から、データのワークツリーを読み書きする `DataStore` を組む。
 *
 * 既定の場所（`.ai-board/data/`）なら、無ければ `root` のリポジトリから `git worktree add` で作る。
 * `AI_BOARD_DATA` は用意済みの clone を指すので、無ければ作らずに失敗させる。
 */
export function createBoardDataStore(paths: BoardPaths, runner: CliRunner): DataStore {
  return createDataStore({
    dataDir: paths.dataDir,
    ...(paths.dataSource === 'env' ? {} : { repoRoot: paths.root }),
    runner,
  });
}

function assemble(
  cardRepository: CardRepository,
  ideaDividerRepository: IdeaDividerRepository
): CardDependencies {
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
