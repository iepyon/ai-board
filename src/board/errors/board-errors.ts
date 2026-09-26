// ============================================================
// ボードコンテキストのエラー（discriminated union）
// ============================================================

export type BoardUnreadable = {
  readonly type: 'BoardUnreadable';
  readonly reason: string;
};

export type GetBoardError = BoardUnreadable;

export type PlanNotFound = {
  readonly type: 'PlanNotFound';
  readonly id: string;
};

export type PlanUnreadable = {
  readonly type: 'PlanUnreadable';
  readonly id: string;
  readonly reason: string;
};

/**
 * `GetBoardError` とは union を混ぜない。
 * 混ぜるとマッピングの switch が起こり得ないケースを持ち、
 * 型による漏れの検出が効かなくなる。
 */
export type GetPlanError = PlanNotFound | PlanUnreadable;
