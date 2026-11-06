import type { DataStoreError } from '../../infrastructure/data-store.js';
import type { GateState, ReviewGate } from '../models/review.js';

// ============================================================
// カードコンテキストのエラー（discriminated union）
// ============================================================

export type CardNotFound = { readonly type: 'CardNotFound'; readonly id: string };
export type DuplicateCardId = { readonly type: 'DuplicateCardId'; readonly id: string };
export type InvalidCardId = { readonly type: 'InvalidCardId'; readonly reason: string };
/** 指定された直前・直後のカードが表示と逆順になっている＝クライアントの表示が古い */
export type StaleOrder = {
  readonly type: 'StaleOrder';
  readonly after: string;
  readonly before: string;
};
export type CardFileMalformed = {
  readonly type: 'CardFileMalformed';
  readonly file: string;
  readonly reason: string;
};

/**
 * カードのファイルのリポジトリが書き込みを拒んだ。`reason` は `CardWriteError` / `OrderFileError` の種別。
 *
 * 判断のエントリを変える本文、`log/` の最新にならない着手の時刻、読めない `card.md` や `order.yaml` で起きる。
 */
export type CardWriteRefused = { readonly type: 'CardWriteRefused'; readonly reason: string };

/**
 * 本文の差し替えで、`## レビュー` のエントリ（`parseReviewLog` で読んだもの）が今と変わる。
 *
 * 判断は追記の usecase からリポジトリの `appendReview` でだけ足す。リポジトリの `save` も判断の変わる本文を拒むが、
 * そのときは `CardWriteRefused` になるので、人に判断のボタンを案内するこのエラーは差し替えの usecase が手前で返す
 * （`createUpdateCardBodyCommand`）。
 */
export type ReviewEntriesChanged = { readonly type: 'ReviewEntriesChanged'; readonly id: string };

/** 人が着手していないカードへの提出（着手は人が指示する） */
export type SubmitBeforeStart = { readonly type: 'SubmitBeforeStart'; readonly id: string };

/** ゲートが未提出でも否決でもないときの提出。`state` は今のゲートの状態 */
export type SubmitGateClosed = {
  readonly type: 'SubmitGateClosed';
  readonly id: string;
  readonly gate: ReviewGate;
  readonly state: GateState;
};

/** ゲートの最新の判断が否決でないときの保留。`state` は今のゲートの状態 */
export type HoldGateNotRejected = {
  readonly type: 'HoldGateNotRejected';
  readonly id: string;
  readonly gate: ReviewGate;
  readonly state: GateState;
};

/**
 * データ用ブランチへの書き込みの 1 操作（`DataStore.transact`）が失敗した。
 *
 * push の失敗（`DataStorePushFailed`）、取り直しの失敗、ロック待ちの上限などを含む。
 * usecase 自身は返さず、サーバと CLI が usecase を `transact` の中で走らせたときに起きる。
 */
export type CardStoreError = DataStoreError;

/** 書き込みを `transact` の中で走らせたときに、usecase のエラーに加わるもの */
export type CardWriteFailure = CardWriteRefused | CardStoreError;

export type CreateCardError = DuplicateCardId | InvalidCardId | CardWriteFailure;
export type GetCardError = CardNotFound;
export type UpdateCardError = CardNotFound | CardWriteFailure;
export type UpdateCardBodyError = UpdateCardError | ReviewEntriesChanged;
export type AppendReviewError = UpdateCardError;
export type SubmitReviewError =
  CardNotFound | SubmitBeforeStart | SubmitGateClosed | CardWriteFailure;
export type HoldReviewError = CardNotFound | HoldGateNotRejected | CardWriteFailure;
export type ListCardsError = CardFileMalformed;
export type MoveCardError = CardNotFound | StaleOrder | CardWriteFailure;
