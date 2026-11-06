import type {
  AppendReviewError,
  CardWriteFailure,
  MoveCardError,
  UpdateCardError,
} from '../../cards/errors/card-errors.js';
import type { DecideRefusal } from '../services/decision-guards.js';

// ============================================================
// ボードコンテキストのエラー（discriminated union）
// ============================================================

export type BoardUnreadable = {
  readonly type: 'BoardUnreadable';
  readonly reason: string;
};

export type GetBoardError = BoardUnreadable;

/**
 * 人の判断を書けなかった理由（`ai-board decide` の usecase が返す）。
 * 検査の拒否、書き込みの中で読んだボードが読めない、カードの usecase の失敗、書き込みの 1 操作（`transact`）の失敗。
 * 人に読める 1 行への直しは CLI が持ち、`switch` で種別を網羅する。
 */
export type DecideError =
  | DecideRefusal
  | BoardUnreadable
  | AppendReviewError
  | UpdateCardError
  | MoveCardError
  | CardWriteFailure;
