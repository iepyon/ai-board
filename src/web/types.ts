// ============================================================
// API レスポンスの型（サーバの BoardCard と対応）
// ============================================================

export type Stage = 'idea' | 'explored' | 'proposed' | 'impling' | 'ai-pr' | 'ai-pr-fixed' | 'done';

export interface Artifacts {
  proposal: boolean;
  specs: boolean;
  design: boolean;
  tasks: boolean;
}

export interface BoardCardOpenSpec {
  change: string;
  artifacts: Artifacts;
  tasks: { completed: number; total: number };
  archived: boolean;
  archivedAs: string | null;
}

export interface BoardCardMr {
  iid: number;
  state: 'opened' | 'closed' | 'locked' | 'merged';
  title: string;
  webUrl: string;
  noteCount: number;
  latestNoteAt: string | null;
  latestCommitAt: string | null;
}

export interface BoardCard {
  id: string;
  title: string;
  created: string;
  stage: Stage;
  derivedStage: Stage;
  overridden: boolean;
  diverged: boolean;
  reason: string;
  stageOverride: Stage | null;
  /** カードのフラグを外したときに残るステージ＝AI の成果物が課す下限 */
  floorStage: Stage;
  /** 人が手でドロップできる列。空なら AI の領分でドラッグ不可 */
  droppableStages: Stage[];
  explored: boolean;
  implStartedAt: string | null;
  change: string | null;
  branch: string | null;
  mr: number | null;
  body: string;
  openspec: BoardCardOpenSpec | null;
  mrState: BoardCardMr | null;
}

export type GitLabConnection =
  { status: 'disabled' } | { status: 'connected' } | { status: 'error'; message: string };

export interface Board {
  stages: Stage[];
  cards: BoardCard[];
  gitlab: GitLabConnection;
  orphanChanges: string[];
  generatedAt: string;
}

/**
 * 人が直接動かせるステージ。残りは openspec と GitLab の実態から
 * 導出されるため、AI の領分としてドロップ先にならない。
 */
export const HUMAN_STAGES: Stage[] = ['idea', 'explored', 'impling'];

export function isHumanStage(stage: Stage): boolean {
  return HUMAN_STAGES.includes(stage);
}

/** 列見出しに出す日本語ラベル */
export const STAGE_LABELS: Record<Stage, string> = {
  idea: 'アイデア',
  explored: '探索済み',
  proposed: '提案済み',
  impling: '実装中',
  'ai-pr': 'AI-PR',
  'ai-pr-fixed': 'AI-PR 修正済み',
  done: '完了',
};

/** 列の帯色 = そのステージを立てる情報源 */
export const STAGE_SOURCE: Record<Stage, 'card' | 'openspec' | 'gitlab' | 'archive'> = {
  idea: 'card',
  explored: 'card',
  proposed: 'openspec',
  impling: 'card',
  'ai-pr': 'gitlab',
  'ai-pr-fixed': 'gitlab',
  done: 'archive',
};
