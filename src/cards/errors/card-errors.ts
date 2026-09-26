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

export type CreateCardError = DuplicateCardId | InvalidCardId;
export type GetCardError = CardNotFound;
export type UpdateCardError = CardNotFound;
export type ListCardsError = CardFileMalformed;
export type MoveCardError = CardNotFound | StaleOrder;
