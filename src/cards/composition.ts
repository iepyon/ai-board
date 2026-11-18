import type { BoardPaths } from '../infrastructure/config.js';
import { err, isErr, ok } from '../shared/result.js';
import { ArtifactMirrorStore } from '../infrastructure/artifact-mirror-store.js';
import type { DocumentStore } from '../infrastructure/document-store.js';
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
 * `ai-board card` の依存を組む。書き込みは `store` の書き込みの 1 操作として送る箱に積む。
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

        // 番号が既に入っていれば、何も書かない（transact は送る箱に積まない）
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

/** 設定の置き場所から、Artifact の DB の写しと送る箱（`DocumentStore`）を組む */
export function createBoardStore(paths: BoardPaths): ArtifactMirrorStore {
  return new ArtifactMirrorStore(paths.storeDir);
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
