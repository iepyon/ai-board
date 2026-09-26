import type { MergeRequestIid } from '../../shared/schemas/common.js';

// ============================================================
// レビュー要求（MR / PR）の状態
// ============================================================

export const MR_STATES = ['opened', 'closed', 'locked', 'merged'] as const;

export type MrLifecycleState = (typeof MR_STATES)[number];

export interface MrState {
  /** どの取得先から引いた状態か */
  readonly forge: ForgeKind;
  readonly iid: MergeRequestIid;
  readonly state: MrLifecycleState;
  readonly sourceBranch: string;
  readonly title: string;
  readonly webUrl: string;
  /**
   * 人が書いた最新のレビューコメント（bot を除く）の作成日時。
   * コメントが 1 件も無ければ null。
   */
  readonly latestNoteAt: string | null;
  /** 人が書いたコメントの件数 */
  readonly noteCount: number;
  /** PR の最新コミットの committed_date */
  readonly latestCommitAt: string | null;
}

/** 取得先の種類 */
export const FORGE_KINDS = ['github'] as const;

export type ForgeKind = (typeof FORGE_KINDS)[number];

/**
 * レビュー要求の取得先への接続状態。
 *
 * ボードは未接続でもカードと計画ファイルだけで動く。
 * `disabled` は設定が無い場合と、CLI が無い・未ログインの場合の両方を表し、
 * どちらであるかは `reason` に出す。
 */
export type ForgeConnection =
  | { readonly status: 'disabled'; readonly kind: ForgeKind | null; readonly reason: string | null }
  | { readonly status: 'connected'; readonly kind: ForgeKind }
  | { readonly status: 'error'; readonly kind: ForgeKind; readonly message: string };
