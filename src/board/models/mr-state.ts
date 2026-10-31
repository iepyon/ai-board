import type { MergeRequestIid } from '../../shared/schemas/common.js';

// ============================================================
// レビュー要求（GitHub の PR）の状態
// ============================================================

export const MR_STATES = ['opened', 'closed', 'locked', 'merged'] as const;

export type MrLifecycleState = (typeof MR_STATES)[number];

export interface MrState {
  /** どの取得先から引いた状態か */
  readonly forge: ForgeKind;
  readonly iid: MergeRequestIid;
  readonly state: MrLifecycleState;
  /**
   * Draft か。AI は計画をコミットした時点で Draft の PR を出し、
   * 人は計画をその PR で読む。Draft のあいだは PR中 の列を立てない
   */
  readonly draft: boolean;
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
  /** マージされた日時。マージされていなければ null */
  readonly mergedAt: string | null;
  /**
   * 最後に Ready にした時刻（`ready_for_review` のイベント）。
   * 作成時から Ready の PR はこのイベントを残さないので、Draft でない PR でイベントが無ければ PR の作成時刻。
   * 今 Draft で一度も Ready にしていなければ null。
   *
   * Draft と Ready を行き来した PR では最後の 1 つを採る。PR レビューの区間はそこから数える
   */
  readonly readyAt: string | null;
  /**
   * 最後に Draft へ戻された時刻（`convert_to_draft` のイベント）。
   * 戻されたことが無い、または今 open かつ Draft でなければ null。
   *
   * `draft` だけでは「まだ一度も Ready にしていない」と「人が Draft に戻した」を
   * 見分けられない。作成時から Draft の PR はこのイベントを残さないので、
   * 値が入っていれば誰かが Ready の PR を Draft に戻したことを意味する
   */
  readonly convertedToDraftAt: string | null;
}

/**
 * 引いた PR の状態と、それを引いたときの PR 本体の「指紋」。
 *
 * 指紋は PR 本体 1 回の問い合わせで分かる値（状態・Draft・head の sha・コメントの件数・更新時刻）を
 * つないだもの。次に引いたとき指紋が同じなら、コメントやコミットを引き直さずに `mr` を使い回す。
 */
export interface MrSnapshot {
  readonly mr: MrState;
  readonly fingerprint: string;
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
