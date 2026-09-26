import type { Stage } from '../../shared/schemas/common.js';
import type { Card } from '../../cards/models/card.js';
import type { GateState, ReviewGate, ReviewKind } from '../../cards/models/review.js';
import type { StageResolution } from '../services/stage-resolver.js';
import type { TaskProgress } from './plan-state.js';
import type { ForgeConnection, ForgeKind, MrLifecycleState } from './mr-state.js';

// ============================================================
// ボードに表示するカード（3 ソースを束ねた読み取りモデル）
// ============================================================

export interface BoardCardPlan {
  /** ステージ判定には使わず、カード上のプログレスバーとして表示するだけ */
  readonly tasks: TaskProgress;
  readonly archived: boolean;
  /** 計画ファイルの最終更新時刻。「しばらく動きが無い」ことの目安 */
  readonly updatedAt: string;
}

export interface BoardCardMr {
  readonly forge: ForgeKind;
  readonly iid: number;
  readonly state: MrLifecycleState;
  readonly title: string;
  readonly webUrl: string;
  readonly noteCount: number;
  readonly latestNoteAt: string | null;
  readonly latestCommitAt: string | null;
  /** レビュー指摘のあとに修正コミットが push されたか＝再レビュー待ち */
  readonly resubmitted: boolean;
  /** マージされた日時。マージされていなければ null */
  readonly mergedAt: string | null;
}

/**
 * plan ゲートの最新エントリ（中止を除く）。
 *
 * 提出の本文には AI が書いた「判断待ちの点」が入り、時刻は人を待ち始めた時刻になる。
 * 本文の `## レビュー` の解析はサーバに閉じ、画面は解析し直さない。
 */
export interface BoardCardReview {
  readonly at: string;
  readonly kind: ReviewKind;
  readonly reason: string;
}

export interface BoardCard {
  readonly id: string;
  readonly title: string;
  readonly created: string;
  readonly stage: Stage;
  readonly reason: string;
  /** 最新のレビューエントリが 中止 か。UI は既定でこのカードを畳む */
  readonly aborted: boolean;
  /** 各ゲートの通過状況 */
  readonly gates: Readonly<Record<ReviewGate, GateState>>;
  /** plan ゲートの最新エントリ。まだ提出されていなければ null */
  readonly latestReview: BoardCardReview | null;
  /** 着手を取り消しても残るステージ＝AI の成果物とレビュー記録が課す下限 */
  readonly floorStage: Stage;
  /** 人が手でドロップできる列。空なら AI の領分でドラッグ不可 */
  readonly droppableStages: readonly Stage[];
  readonly startedAt: string | null;
  readonly skipGates: readonly ReviewGate[];
  readonly branch: string | null;
  readonly mr: number | null;
  /** 並び順。`cards` はこの実効値の順に並んで届く */
  readonly rank: number | null;
  readonly body: string;
  /** 計画ファイルがまだ無ければ null */
  readonly plan: BoardCardPlan | null;
  /** PR が未紐付け、または GitHub 未接続なら null */
  readonly mrState: BoardCardMr | null;
}

export interface Board {
  readonly cards: readonly BoardCard[];
  readonly forge: ForgeConnection;
  /** 対応するカードが無い計画ファイルのカード ID（消し忘れの発見に使う） */
  readonly orphanPlans: readonly string[];
  /**
   * アイデアの表の区切り線の rank。実効値がこれより小さいアイデアが「次にやる」。
   * 一度も動かしていなければ null（すべてのアイデアが「次にやる」）
   */
  readonly ideaDivider: number | null;
  readonly generatedAt: string;
}

/** Card と導出結果から BoardCard を組み立てる */
export function toBoardCard(
  card: Card,
  resolution: StageResolution,
  movement: {
    floorStage: Stage;
    droppableStages: readonly Stage[];
  },
  latestReview: BoardCardReview | null,
  plan: BoardCardPlan | null,
  mrState: BoardCardMr | null
): BoardCard {
  return {
    id: card.id,
    title: card.title,
    created: card.created,
    stage: resolution.stage,
    reason: resolution.reason,
    aborted: resolution.aborted,
    gates: resolution.gates,
    latestReview,
    floorStage: movement.floorStage,
    droppableStages: movement.droppableStages,
    startedAt: card.startedAt,
    skipGates: card.skipGates,
    branch: card.branch,
    mr: card.mr,
    rank: card.rank,
    body: card.body,
    plan,
    mrState,
  };
}
