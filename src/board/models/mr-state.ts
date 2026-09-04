import type { MergeRequestIid } from '../../shared/schemas/common.js';

// ============================================================
// GitLab Merge Request の状態
// ============================================================

export const MR_STATES = ['opened', 'closed', 'locked', 'merged'] as const;

export type MrLifecycleState = (typeof MR_STATES)[number];

export interface MrState {
  readonly iid: MergeRequestIid;
  readonly state: MrLifecycleState;
  readonly sourceBranch: string;
  readonly title: string;
  readonly webUrl: string;
  /**
   * system でない最新ノート（＝人が書いたレビューコメント）の作成日時。
   * ノートが 1 件も無ければ null。
   */
  readonly latestNoteAt: string | null;
  /** 人が書いたノートの件数 */
  readonly noteCount: number;
  /** MR の最新コミットの committed_date */
  readonly latestCommitAt: string | null;
}

/** GitLab への接続状態。ボードは未接続でも openspec 由来の情報だけで動く */
export type GitLabConnection =
  | { readonly status: 'disabled' }
  | { readonly status: 'connected' }
  | { readonly status: 'error'; readonly message: string };
