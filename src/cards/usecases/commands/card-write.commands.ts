import type { Result } from '../../../shared/result.js';
import type { DataStore } from '../../../infrastructure/data-store.js';
import type { Card } from '../../models/card.js';
import type {
  CreateCardError,
  HoldReviewError,
  SubmitReviewError,
  UpdateCardBodyError,
  UpdateCardError,
} from '../../errors/card-errors.js';
import type { CreateCardCommand, CreateCardInput } from './create-card.command.js';
import type { UpdateCardBodyCommand, UpdateCardBodyInput } from './update-card-body.command.js';
import type { LinkCardBranchCommand, LinkCardBranchInput } from './link-card-branch.command.js';
import type { SubmitReviewCommand, SubmitReviewCommandInput } from './submit-review.command.js';
import type { HoldReviewCommand, HoldReviewCommandInput } from './hold-review.command.js';
import { transactCardWrite } from './transact-card-write.js';

// ============================================================
// AI が書いてよいカードの書き込み — 1 操作ずつ、コミットのメッセージを決めて書く
// ============================================================

/**
 * `ai-board card` が書き込みに使う口。どれも書き込みの 1 操作（`transactCardWrite`）として、コミットして push する。
 *
 * AI に許す書き込み（起票・本文・ブランチの紐付け・提出 / 再提出・保留）だけを並べる。
 * 人の判断（承認 / 差し戻し / 中止の追記、`startedAt` / `skipGates` / `rank` の書き換え）を書く口は、ここに置かない。
 * 失敗には、usecase のエラーに加えて、リポジトリの拒否と `transact` の失敗（`CardWriteFailure`）が入る。
 */
export interface CardWriteCommands {
  readonly create: (input: CreateCardInput) => Promise<Result<Card, CreateCardError>>;
  readonly replaceBody: (input: UpdateCardBodyInput) => Promise<Result<Card, UpdateCardBodyError>>;
  readonly linkBranch: (input: LinkCardBranchInput) => Promise<Result<Card, UpdateCardError>>;
  readonly submit: (input: SubmitReviewCommandInput) => Promise<Result<Card, SubmitReviewError>>;
  readonly hold: (input: HoldReviewCommandInput) => Promise<Result<Card, HoldReviewError>>;
}

/** 書き込みの usecase。`store` のデータのワークツリーを読み書きするもの */
export interface CardWriteUsecases {
  readonly createCardCommand: CreateCardCommand;
  readonly updateCardBodyCommand: UpdateCardBodyCommand;
  readonly linkCardBranchCommand: LinkCardBranchCommand;
  readonly submitReviewCommand: SubmitReviewCommand;
  readonly holdReviewCommand: HoldReviewCommand;
}

/**
 * カードの usecase を、書き込みの 1 操作の中で走らせる口に包む。コミットのメッセージはここで決める。
 * メッセージには ID・ゲート・種別・変えた項目の名前だけを入れ、ブランチ名や理由は入れない。
 */
export function createCardWriteCommands(
  store: Pick<DataStore, 'transact'>,
  usecases: CardWriteUsecases
): CardWriteCommands {
  return {
    create: (input) =>
      transactCardWrite(
        store,
        (card: Card) => `data: ${card.id} を作る`,
        () => usecases.createCardCommand(input)
      ),

    replaceBody: (input) =>
      transactCardWrite(store, `data: ${input.id} の本文を差し替える`, () =>
        usecases.updateCardBodyCommand(input)
      ),

    linkBranch: (input) =>
      transactCardWrite(
        store,
        input.branch === null
          ? `data: ${input.id} のブランチを外す`
          : `data: ${input.id} にブランチを紐付ける`,
        () => usecases.linkCardBranchCommand(input)
      ),

    submit: (input) =>
      transactCardWrite(
        store,
        `data: ${input.id} に ${input.gate} ${input.resubmit ? '再提出' : '提出'} を足す`,
        () => usecases.submitReviewCommand(input)
      ),

    hold: (input) =>
      transactCardWrite(store, `data: ${input.id} に ${input.gate} 保留 を足す`, () =>
        usecases.holdReviewCommand(input)
      ),
  };
}
