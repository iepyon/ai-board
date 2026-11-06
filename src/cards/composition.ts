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
import type { IdeaDividerRepository } from './repositories/idea-divider.repository.js';
import { CardWriteRefusedError, FileCardRepository } from './repositories/file-card.repository.js';
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
  createSubmitReviewCommand,
  type SubmitReviewCommand,
} from './usecases/commands/submit-review.command.js';
import {
  createHoldReviewCommand,
  type HoldReviewCommand,
} from './usecases/commands/hold-review.command.js';
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
  /** 人の判断（承認 / 差し戻し / 中止）を足す。AI の CLI（`ai-board card`）には渡さない */
  readonly appendReviewCommand: AppendReviewCommand;
  /** AI の 提出 / 再提出 を足す。着手とゲートの状態を確かめる */
  readonly submitReviewCommand: SubmitReviewCommand;
  /** AI の 保留 を足す。ゲートの最新が差し戻しかを確かめる */
  readonly holdReviewCommand: HoldReviewCommand;
  readonly moveCardCommand: MoveCardCommand;
  readonly moveIdeaDividerCommand: MoveIdeaDividerCommand;
}

/**
 * データのワークツリーのファイルでカードを読み書きする。
 *
 * リポジトリはコミットと push を持たない。書き込みの usecase は `transactCardWrite` の中で呼ぶ。
 */
export function createFileCardDependencies(dataDir: string): CardDependencies {
  return assemble(new FileCardRepository(dataDir), new FileIdeaDividerRepository(dataDir));
}

/**
 * `op` を書き込みの 1 操作（`DataStore.transact`）の中で走らせる。CLI の書き込みは、どれもここを通す。
 *
 * `op` には、書く前の検査から usecase までを入れる。push が拒否されると、`transact` が取り直した最新の状態で
 * `op` を頭から呼び直すので、検査は必ず最新のカードに対して行われる（ADR 0010）。
 * そのため `op` は標準出力にも標準エラーにも書かない。拒むときは Err を返す（`transact` が書きかけを捨て、コミットしない）。
 *
 * 判断の書き換えなど、リポジトリの拒否は `CardWriteRefusedError` の例外で届くので、`CardWriteRefused` の Err に直す。
 * `transact` は同じプロセスの中で 1 列に並ぶので、`op` の中からこれを呼ぶと自分を待って止まる。
 */
export function transactCardWrite<T, E>(
  store: Pick<DataStore, 'transact'>,
  message: CommitMessage<T>,
  op: () => Promise<Result<T, E>>
): Promise<Result<T, E | CardWriteFailure>> {
  return store.transact<T, E | CardWriteFailure>(message, async () => {
    try {
      return await op();
    } catch (error) {
      if (error instanceof CardWriteRefusedError) {
        return err({ type: 'CardWriteRefused', reason: error.reason.type });
      }
      throw error;
    }
  });
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
    submitReviewCommand: createSubmitReviewCommand(cardRepository),
    holdReviewCommand: createHoldReviewCommand(cardRepository),
    moveCardCommand: createMoveCardCommand(order),
    moveIdeaDividerCommand: createMoveIdeaDividerCommand(order),
  };
}
