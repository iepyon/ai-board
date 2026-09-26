import type { Stage } from '../../shared/schemas/common.js';
import type { Card } from '../../cards/models/card.js';
import type { GateState, ReviewGate } from '../../cards/models/review.js';
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
}

export interface BoardCardMr {
  /** 番号の接頭辞を出し分けるために取得先を持つ（GitLab は `!`、GitHub は `#`） */
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
  /** 着手を取り消しても残るステージ＝AI の成果物とレビュー記録が課す下限 */
  readonly floorStage: Stage;
  /** 人が手でドロップできる列。空なら AI の領分でドラッグ不可 */
  readonly droppableStages: readonly Stage[];
  readonly startedAt: string | null;
  readonly skipGates: readonly ReviewGate[];
  readonly branch: string | null;
  readonly mr: number | null;
  readonly body: string;
  /** 計画ファイルがまだ無ければ null */
  readonly plan: BoardCardPlan | null;
  /** MR が未紐付け、または GitLab 未接続なら null */
  readonly mrState: BoardCardMr | null;
}

export interface Board {
  readonly cards: readonly BoardCard[];
  readonly forge: ForgeConnection;
  /** 対応するカードが無い計画ファイルのカード ID（消し忘れの発見に使う） */
  readonly orphanPlans: readonly string[];
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
    floorStage: movement.floorStage,
    droppableStages: movement.droppableStages,
    startedAt: card.startedAt,
    skipGates: card.skipGates,
    branch: card.branch,
    mr: card.mr,
    body: card.body,
    plan,
    mrState,
  };
}
