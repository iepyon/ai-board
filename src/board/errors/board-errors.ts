// ============================================================
// ボードコンテキストのエラー（discriminated union）
// ============================================================

export type BoardUnreadable = {
  readonly type: 'BoardUnreadable';
  readonly reason: string;
};

export type GetBoardError = BoardUnreadable;
