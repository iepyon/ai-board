import type { AppConfig } from '../infrastructure/config.js';
import { err, isErr, ok, type Result } from '../shared/result.js';
import { createCliRunner } from '../infrastructure/cli-runner.js';
import {
  initialDocuments,
  type Collection,
  type DocumentData,
  type DocumentStore,
  type StoreError,
} from '../infrastructure/document-store.js';
import { GitDocumentStore } from '../infrastructure/git-document-store.js';
import { changedStoreFiles, type BranchCheckError } from '../infrastructure/git-branch-check.js';
import { resolvePlanCommit } from '../infrastructure/git-plan-tree.js';
import { cardFileCodec, isStoreFilePath } from './repositories/card-file-codec.js';
import {
  EMPTY_ORDER,
  ORDER_COLLECTION,
  ORDER_ID,
  orderDocumentData,
} from './repositories/card-files.js';
import type { PrNumberWriter } from '../infrastructure/pr-fetcher.js';
import type { CardRepository } from './repositories/card.repository.js';
import type { IdeaDividerRepository } from './repositories/idea-divider.repository.js';
import {
  CardWriteRefusedError,
  DocCardRepository,
  DocIdeaDividerRepository,
} from './repositories/doc-card.repository.js';
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
import {
  createLinkCardBranchCommand,
  type LinkCardBranchCommand,
} from './usecases/commands/link-card-branch.command.js';
import {
  createCardWriteCommands,
  type CardWriteCommands,
} from './usecases/commands/card-write.commands.js';

// ============================================================
// Cards コンテキスト 依存性構成
// ============================================================

export interface CardDependencies {
  readonly cardRepository: CardRepository;
  readonly ideaDividerRepository: IdeaDividerRepository;
  readonly createCardCommand: CreateCardCommand;
  readonly updateCardMetaCommand: UpdateCardMetaCommand;
  readonly updateCardBodyCommand: UpdateCardBodyCommand;
  /** ブランチの紐付け。`branch` だけを書き換える（AI の CLI はメタデータをこれでしか書かない） */
  readonly linkCardBranchCommand: LinkCardBranchCommand;
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
 * 置き場所の文書でカードを読み書きする。
 *
 * 書き込みの usecase は `transactCardWrite`（`usecases/commands/transact-card-write.ts`）の中で呼ぶ。
 */
export function createCardDependencies(store: DocumentStore): CardDependencies {
  return assemble(new DocCardRepository(store), new DocIdeaDividerRepository(store));
}

/** `ai-board card` が使う依存。読む口と、AI に許す書き込みの口だけ */
export interface CardCliParts {
  /** 置き場所のカードを読む */
  readonly cards: Pick<CardDependencies, 'cardRepository'>;
  /**
   * AI に許す書き込みだけ（起票・本文・ブランチの紐付け・提出 / 再提出・保留）。
   * 人の判断を書く口（承認 / 差し戻し / 中止の追記と、`startedAt` / `skipGates` の書き換え）は無い
   */
  readonly writes: CardWriteCommands;
}

/**
 * `ai-board card` の依存を組む。書き込みは `store` の書き込みの 1 操作として置き場所へ push する。
 * 人の判断を書く usecase（`appendReviewCommand`・`updateCardMetaCommand`）は渡さない。
 */
export function createCardCliParts(store: DocumentStore): CardCliParts {
  const cards = createCardDependencies(store);
  return {
    cards: { cardRepository: cards.cardRepository },
    writes: createCardWriteCommands(store, cards),
  };
}

/**
 * `PrFetcher` が PR 番号を書き戻すとき、書き込みの 1 操作（`DocumentStore.transact`）の中で書く。
 *
 * 最新のカードを読み直し、番号が違うときだけ番号を書く（人がその間に書いた判断などを消さない）。
 * 束の名前には ID だけを入れ、ブランチ名は入れない。
 *
 * 書けなくても（ロックの待ち切れ、リポジトリの拒否）、警告するだけで例外を投げない。
 * 投げると `PrFetcher` の接続の状態が error になり、ループが止まる。番号は次の問い合わせで解決し直される。
 * `transact` の中から呼ばないこと（同じプロセスの中で 1 列に並ぶので、自分を待って止まる）。
 */
export function createTransactionalPrWriter(
  store: DocumentStore,
  warn: (message: string) => void = (message) => console.warn(message)
): PrNumberWriter {
  return async (cardId, number) => {
    const result = await store.transact<void, CardWriteRefusedError['reason']>(
      `${cardId} の PR 番号を書き戻す`,
      async () => {
        const repository = new DocCardRepository(store);
        const latest = await repository.findById(cardId);

        // 番号が既に入っていれば、何も書かない（transact は置き場所にコミットしない）
        if (latest === null || latest.pr === number) return ok(undefined);

        try {
          await repository.save({ ...latest, pr: number });
        } catch (error) {
          // 今のカードの文書が読めないなど。書きかけは transact が捨てる
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

/** fetch と push は既定の上限（10 秒）では足りないことがある */
const STORE_TIMEOUT_MS = 60_000;
/** `cat-file --batch` で置き場所のファイルを全部読むので、上限を大きくする */
const STORE_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * 設定の置き場所から、git の置き場所（`DocumentStore`）を組む。
 * カード・判断・並び順・形の版は置き場所のブランチのファイルに、PR の控えとループの記録は手元（`localDir`）に置く
 */
export function createBoardStore(config: AppConfig): GitDocumentStore {
  return new GitDocumentStore({
    repoDir: config.paths.repoDir,
    remote: config.store.remote,
    branch: config.store.branch,
    localDir: config.paths.localDir,
    codec: cardFileCodec,
    runner: createStoreRunner(),
  });
}

function createStoreRunner(): ReturnType<typeof createCliRunner> {
  return createCliRunner({ timeoutMs: STORE_TIMEOUT_MS, maxBuffer: STORE_MAX_BUFFER });
}

/** 空の置き場所に書く最初の文書（形の版と、空の並び順）。`ai-board store init` が書く */
export function initialBoardDocuments(): readonly {
  collection: Collection;
  id: string;
  data: DocumentData;
}[] {
  return [
    ...initialDocuments(),
    { collection: ORDER_COLLECTION, id: ORDER_ID, data: orderDocumentData(EMPTY_ORDER) },
  ];
}

/** `ai-board store` の `init` と `check-branch` の口 */
export interface StoreCliParts {
  readonly initialize: () => Promise<Result<void, StoreError>>;
  readonly checkBranch: (
    branch: string
  ) => Promise<Result<readonly string[], StoreError | BranchCheckError>>;
}

/** `ai-board store` の口を組む。`check-branch` は置き場所を読み込んでから、その先頭とブランチの差分を見る */
export function createStoreCliParts(config: AppConfig, store: GitDocumentStore): StoreCliParts {
  return {
    initialize: () => store.initialize(initialBoardDocuments()),
    checkBranch: async (branch) => {
      const checked = await store.check();
      if (isErr(checked)) return checked;
      const runner = createStoreRunner();
      // カードのブランチはコードの main から切るので、比べる先はコードの main。
      // 置き場所が専用のブランチだと共通の祖先が無く、merge-base を取れない
      const base = await resolvePlanCommit({
        runner,
        repoDir: config.paths.repoDir,
        store: config.store,
        storeHead: store.headCommit(),
      });
      // 置き場所の先頭とコードの main のどちらが無くても、検査はせず「置き場所が無い」で止める
      return changedStoreFiles({
        runner,
        repoDir: config.paths.repoDir,
        storeHead: base,
        branch,
        isStoreFile: isStoreFilePath,
      });
    },
  };
}

function assemble(
  cardRepository: CardRepository,
  ideaDividerRepository: IdeaDividerRepository
): CardDependencies {
  const order = { cards: cardRepository, divider: ideaDividerRepository };

  const updateCardMetaCommand = createUpdateCardMetaCommand(cardRepository);

  return {
    cardRepository,
    ideaDividerRepository,
    createCardCommand: createCreateCardCommand(cardRepository),
    updateCardMetaCommand,
    updateCardBodyCommand: createUpdateCardBodyCommand(cardRepository),
    linkCardBranchCommand: createLinkCardBranchCommand(updateCardMetaCommand),
    appendReviewCommand: createAppendReviewCommand(cardRepository),
    submitReviewCommand: createSubmitReviewCommand(cardRepository),
    holdReviewCommand: createHoldReviewCommand(cardRepository),
    moveCardCommand: createMoveCardCommand(order),
    moveIdeaDividerCommand: createMoveIdeaDividerCommand(order),
  };
}
