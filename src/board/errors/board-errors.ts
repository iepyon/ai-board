import type {
  AppendReviewError,
  CardWriteFailure,
  MoveCardError,
  UpdateCardError,
} from '../../cards/errors/card-errors.js';
import type { CardId, Stage } from '../../shared/schemas/common.js';
import type { Decision } from '../services/decision-options.js';
import type { BoardCard } from '../models/board-card.js';
import type { ForgeConnection } from '../models/pr-state.js';

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
 * 人に読める 1 行への直しは presenters（`decide-messages.ts`）が持ち、`switch` で種別を網羅する。
 */
export type DecideError =
  | DecideRefusal
  | BoardUnreadable
  | AppendReviewError
  | UpdateCardError
  | MoveCardError
  | CardWriteFailure;

/**
 * 人の判断を書けない理由（discriminated union）。
 *
 * どれも導出済みの `Board` だけで決まる。引数の形（カード ID・`--after` / `--before` の値・`--gate`）の誤りは
 * ボードを読む前に CLI が拒むので、ここには入れない。検査は `decision-guards.ts` の純関数が行い、人に読める 1 行への直しは presenters（`decide-messages.ts`）が持つ。
 */
export type DecideRefusal =
  /** GitHub に繋がらない。列と出せる判断が PR の状態に依るので、承認 / 差し戻し / 中止と着手 / 着手を戻すは拒む */
  | {
      readonly type: 'ForgeUnavailable';
      readonly action: 'review' | 'startedAt';
      readonly forge: ForgeConnection;
    }
  | { readonly type: 'CardNotFound'; readonly id: CardId }
  /** そのカードに、その種別の判断が出ていない（`decisionsFor`） */
  | {
      readonly type: 'DecisionUnavailable';
      readonly id: CardId;
      readonly kind: Decision['kind'];
      readonly card: BoardCard;
    }
  | { readonly type: 'ReasonRequired'; readonly kind: Decision['kind'] }
  /** 今の列が `from` でないか、`to` へ入れられない（`droppableStages`） */
  | {
      readonly type: 'StageMismatch';
      readonly id: CardId;
      readonly from: Stage;
      readonly to: Stage;
      readonly card: BoardCard;
    }
  | { readonly type: 'CardAborted'; readonly id: CardId }
  /** アイデアの表に並んでいない（`ref` はカード ID か区切り線） */
  | { readonly type: 'NotInIdeaTable'; readonly ref: string };
