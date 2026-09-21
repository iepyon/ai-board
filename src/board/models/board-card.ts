import type { Stage } from '../../shared/schemas/common.js';
import type { Card } from '../../cards/models/card.js';
import type { GateState, ReviewGate } from '../../cards/models/review.js';
import type { StageResolution } from '../services/stage-resolver.js';
import type { OpenSpecArtifacts, TaskProgress } from './openspec-state.js';
import type { ForgeConnection, ForgeKind, MrLifecycleState } from './mr-state.js';

// ============================================================
// ボードに表示するカード（3 ソースを束ねた読み取りモデル）
// ============================================================

export interface BoardCardOpenSpec {
  readonly change: string;
  readonly artifacts: OpenSpecArtifacts;
  /** ステージ判定には使わず、カード上のプログレスバーとして表示するだけ */
  readonly tasks: TaskProgress;
  readonly archived: boolean;
  readonly archivedAs: string | null;
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
  readonly change: string | null;
  readonly branch: string | null;
  readonly mr: number | null;
  readonly body: string;
  /** change が openspec 側に見つからなければ null */
  readonly openspec: BoardCardOpenSpec | null;
  /** MR が未紐付け、または GitLab 未接続なら null */
  readonly mrState: BoardCardMr | null;
}

export interface Board {
  readonly cards: readonly BoardCard[];
  readonly forge: ForgeConnection;
  /** カードに紐付いていない openspec change の名前（紐付け漏れの発見に使う） */
  readonly orphanChanges: readonly string[];
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
  openspec: BoardCardOpenSpec | null,
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
    change: card.change,
    branch: card.branch,
    mr: card.mr,
    body: card.body,
    openspec,
    mrState,
  };
}
