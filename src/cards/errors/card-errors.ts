// ============================================================
// カードコンテキストのエラー（discriminated union）
// ============================================================

export type CardNotFound = { readonly type: 'CardNotFound'; readonly id: string };
export type DuplicateCardId = { readonly type: 'DuplicateCardId'; readonly id: string };
export type InvalidCardId = { readonly type: 'InvalidCardId'; readonly reason: string };
export type CardFileMalformed = {
  readonly type: 'CardFileMalformed';
  readonly file: string;
  readonly reason: string;
};

export type CreateCardError = DuplicateCardId | InvalidCardId;
export type GetCardError = CardNotFound;
export type UpdateCardError = CardNotFound;
export type ListCardsError = CardFileMalformed;
