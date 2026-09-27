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

/** 変更ファイルが読めない、または操作として不正（無いカードを title / created なしで作ろうとした等） */
export type ChangeFileMalformed = {
  readonly type: 'ChangeFileMalformed';
  readonly file: string;
  readonly reason: string;
};
/**
 * DB に、まだ変更ファイルへ書き出していない変更がある。
 * このまま適用すると手元の変更を上書きするので、先に書き出させる。
 */
export type UnrecordedChanges = {
  readonly type: 'UnrecordedChanges';
  readonly cardIds: readonly string[];
  readonly divider: boolean;
};

export type CreateCardError = DuplicateCardId | InvalidCardId;
export type GetCardError = CardNotFound;
export type UpdateCardError = CardNotFound;
export type ListCardsError = CardFileMalformed;
export type MoveCardError = CardNotFound | StaleOrder;
export type RecordChangesError = ChangeFileMalformed;
export type ApplyChangesError = ChangeFileMalformed | UnrecordedChanges;
