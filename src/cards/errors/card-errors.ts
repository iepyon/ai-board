import type { DataStoreError } from '../../infrastructure/data-store.js';

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
 * 判断の理由に、判断の見出し（`### <ISO8601> <gate> <種別>`）として読める行がある。`line` はその最初の行。
 *
 * そのまま書くと、理由の中の行が別の判断（承認など）として読まれるので、書かずに拒む（`findEntryHeadingLine`）。
 */
export type ReasonHasEntryHeading = {
  readonly type: 'ReasonHasEntryHeading';
  readonly line: string;
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
export type AppendReviewError = UpdateCardError | ReasonHasEntryHeading;
export type ListCardsError = CardFileMalformed;
export type MoveCardError = CardNotFound | StaleOrder | CardWriteFailure;
