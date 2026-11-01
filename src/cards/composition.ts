import type { DatabaseSync } from 'node:sqlite';
import type { BoardPaths } from '../shared/config.js';
import type { CliRunner } from '../infrastructure/cli-runner.js';
import { err, isErr, ok, type Result } from '../shared/result.js';
import {
  createDataStore,
  type CommitMessage,
  type DataStore,
} from '../infrastructure/data-store.js';
import type { MrNumberWriter } from '../infrastructure/forge-poller.js';
import type { CardWriteFailure } from './errors/card-errors.js';
import type { CardRepository } from './repositories/card.repository.js';
import { SqliteCardRepository } from './repositories/sqlite-card.repository.js';
import type { IdeaDividerRepository } from './repositories/idea-divider.repository.js';
import { SqliteIdeaDividerRepository } from './repositories/sqlite-idea-divider.repository.js';
import { CardWriteRefusedError, FileCardRepository } from './repositories/file-card.repository.js';
import { FileIdeaDividerRepository } from './repositories/file-idea-divider.repository.js';
import {
  createCreateCardCommand,
  type CreateCardCommand,
} from './usecases/commands/create-card.command.js';
import {
  createUpdateCardMetaCommand,
  type UpdateCardMetaCommand,
  type UpdateCardMetaPatch,
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
 * サーバのカードの依存。書き込みの usecase を、それぞれ書き込みの 1 操作（`DataStore.transact`）の中で走らせる。
 *
 * 読み出しはデータのワークツリーのファイルをそのまま読む。書き込みは取り直した最新の状態に対して usecase を走らせ、
 * コミットと push が終わってから応答を返す。push に失敗すれば `DataStorePushFailed` などのエラーになる。
 * `onWrite` は書き込みが push まで通った後に呼ぶ（SSE で画面へ知らせるため）。
 *
 * CLI はコマンドごとの検査も同じ `transact` に入れるので、これではなく `createFileCardDependencies` を使う。
 * `transact` は同じプロセスの中で 1 列に並ぶので、`transact` の中からこれを呼ぶと自分を待って止まる。
 */
export function createTransactionalCardDependencies(
  store: Pick<DataStore, 'dataDir' | 'transact'>,
  onWrite: () => void = () => undefined
): CardDependencies {
  const files = createFileCardDependencies(store.dataDir);

  const inTransaction = <I, T, E>(
    message: (input: I) => CommitMessage<T>,
    command: (input: I) => Promise<Result<T, E>>
  ): ((input: I) => Promise<Result<T, E | CardWriteFailure>>) => {
    return async (input) => {
      const result = await store.transact<T, E | CardWriteFailure>(message(input), async () => {
        try {
          return await command(input);
        } catch (error) {
          // 判断の書き換えなど、リポジトリの拒否は例外で届く。書きかけは transact が捨てる
          if (error instanceof CardWriteRefusedError) {
            return err({ type: 'CardWriteRefused', reason: error.reason.type });
          }
          throw error;
        }
      });

      if (result.ok) onWrite();
      return result;
    };
  };

  // コミットには ID・ゲート・種別・変えた項目の名前だけを入れる。理由・本文・ブランチ名は入れない
  return {
    ...files,
    createCardCommand: inTransaction(
      () => (card) => `data: ${card.id} を作る`,
      files.createCardCommand
    ),
    updateCardMetaCommand: inTransaction(
      ({ id, patch }) => `data: ${id} の ${describePatch(patch)} を変える`,
      files.updateCardMetaCommand
    ),
    updateCardBodyCommand: inTransaction(
      ({ id }) => `data: ${id} の本文を差し替える`,
      files.updateCardBodyCommand
    ),
    appendReviewCommand: inTransaction(
      ({ id, gate, kind }) => `data: ${id} に ${gate} ${kind} を足す`,
      files.appendReviewCommand
    ),
    moveCardCommand: inTransaction(({ id }) => `data: ${id} を並べ替える`, files.moveCardCommand),
    moveIdeaDividerCommand: inTransaction(
      () => 'data: 区切り線を動かす',
      files.moveIdeaDividerCommand
    ),
  };
}

/**
 * ポーラーが PR 番号を書き戻すとき、書き込みの 1 操作（`DataStore.transact`）の中で書く。
 *
 * データのワークツリーのファイルを書くだけでは、コミットも push もされず、次の取り直しで捨てられる。
 * 取り直した最新のカードを読み直し、番号が違うときだけ番号を書く（人がその間に書いた判断などを消さない）。
 * コミットには ID だけを入れ、ブランチ名は入れない。
 *
 * 書けなくても（オフライン、push の拒否、ロックの待ち切れ、リポジトリの拒否）、警告するだけで例外を投げない。
 * 投げるとポーラーの接続の状態が error になり、ループが止まる。番号は次の問い合わせで解決し直される。
 * `transact` の中から呼ばないこと（同じプロセスの中で 1 列に並ぶので、自分を待って止まる）。
 */
export function createTransactionalMrWriter(
  store: Pick<DataStore, 'transact'>,
  warn: (message: string) => void = (message) => console.warn(message)
): MrNumberWriter {
  return async (cardId, iid) => {
    const result = await store.transact<void, CardWriteRefusedError['reason']>(
      `data: ${cardId} の mr を書き戻す`,
      async (dataDir) => {
        const repository = new FileCardRepository(dataDir);
        const latest = await repository.findById(cardId);

        // 取り直した後に番号が既に入っていれば、何も書かない（transact はコミットしない）
        if (latest === null || latest.mr === iid) return ok(undefined);

        try {
          await repository.save({ ...latest, mr: iid });
        } catch (error) {
          // 今の card.md が読めないなど。書きかけは transact が捨てる
          if (error instanceof CardWriteRefusedError) return err(error.reason);
          throw error;
        }
        return ok(undefined);
      }
    );

    if (isErr(result)) {
      warn(`[ai-board] ${cardId} の PR 番号を書き戻せませんでした: ${result.error.type}`);
    }
  };
}

/** 変える frontmatter の項目の名前。値は入れない */
function describePatch(patch: UpdateCardMetaPatch): string {
  const keys = Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  return keys.length === 0 ? 'frontmatter' : keys.join(', ');
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
