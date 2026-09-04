import type { Stage } from '../../shared/schemas/common.js';
import type { Card } from '../../cards/models/card.js';
import type { OpenSpecArtifacts, TaskProgress } from './openspec-state.js';
import type { GitLabConnection, MrLifecycleState } from './mr-state.js';

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
  readonly iid: number;
  readonly state: MrLifecycleState;
  readonly title: string;
  readonly webUrl: string;
  readonly noteCount: number;
  readonly latestNoteAt: string | null;
  readonly latestCommitAt: string | null;
}

export interface BoardCard {
  readonly id: string;
  readonly title: string;
  readonly created: string;
  readonly stage: Stage;
  readonly derivedStage: Stage;
  readonly overridden: boolean;
  readonly diverged: boolean;
  readonly reason: string;
  /** 手動上書きの生の値。null なら自動導出に従っている */
  readonly stageOverride: Stage | null;
  /** カードのフラグを外したときに残るステージ＝AI の成果物が課す下限 */
  readonly floorStage: Stage;
  /** 人が手でドロップできる列。空なら AI の領分でドラッグ不可 */
  readonly droppableStages: readonly Stage[];
  readonly explored: boolean;
  readonly implStartedAt: string | null;
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
  readonly gitlab: GitLabConnection;
  /** カードに紐付いていない openspec change の名前（紐付け漏れの発見に使う） */
  readonly orphanChanges: readonly string[];
  readonly generatedAt: string;
}

/** Card と導出結果から BoardCard を組み立てる */
export function toBoardCard(
  card: Card,
  resolution: {
    stage: Stage;
    derived: Stage;
    overridden: boolean;
    diverged: boolean;
    reason: string;
  },
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
    derivedStage: resolution.derived,
    overridden: resolution.overridden,
    diverged: resolution.diverged,
    reason: resolution.reason,
    stageOverride: card.stageOverride,
    floorStage: movement.floorStage,
    droppableStages: movement.droppableStages,
    explored: card.explored,
    implStartedAt: card.implStartedAt,
    change: card.change,
    branch: card.branch,
    mr: card.mr,
    body: card.body,
    openspec,
    mrState,
  };
}
