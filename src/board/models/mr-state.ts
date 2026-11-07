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
  /** 人が書いたコメントの件数。AI が人のアカウントで書いたコメント（`latestAiNoteAt`）は数えない */
  readonly noteCount: number;
  /**
   * AI が人のアカウントで書いた最新のコメント（本文に Claude Code のフッターを含む）の作成日時。無ければ null。
   * 指摘に AI が返信で応えたかの判定（`awaitsPrFix`）に使う
   */
  readonly latestAiNoteAt: string | null;
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

/**
 * 1 枚のカードの PR を引けなかったこと（`scope: 'card'` の失敗）。
 *
 * 接続はまるごと止めず、そのカードだけを止まりにする（`resolveHold`）。
 * 失敗が続くあいだは `since` を最初の時刻のまま保ち、引けたら消える。どこにも保存しない
 */
export interface ForgeCardFailure {
  /** 人が読む 1 行（例: `PR #68 の取得（pulls/68）が HTTP 422 で失敗した`） */
  readonly message: string;
  /** 失敗し始めた時刻 */
  readonly since: string;
}

/** 取得先の種類 */
export const FORGE_KINDS = ['github'] as const;

export type ForgeKind = (typeof FORGE_KINDS)[number];

/**
 * レビュー要求の取得先への接続状態。
 *
 * ボードは未接続でもカードと計画ファイルだけで動く。
 * `disabled` は設定が無い場合と、CLI が無い・未ログインの場合の両方を表し、
 * どちらであるかは `reason` に出す。設定が無い（未設定）ときだけ `kind` が null になる（`isForgeUnset`）。
 */
export type ForgeConnection =
  | { readonly status: 'disabled'; readonly kind: ForgeKind | null; readonly reason: string | null }
  | { readonly status: 'connected'; readonly kind: ForgeKind }
  | { readonly status: 'error'; readonly kind: ForgeKind; readonly message: string };

/**
 * 取得先が未設定か（`config.yaml` に `github:` が無い）。
 *
 * `kind` が null の `disabled` は、設定が無いときにだけ作られる（`createMrStateSource`）。
 * 設定があって CLI が無い・未ログイン・届かないときは `kind` が付くので、偽になる。
 * `reason` の文言には依らない。
 */
export function isForgeUnset(forge: ForgeConnection): boolean {
  return forge.status === 'disabled' && forge.kind === null;
}

/**
 * このボードの列を、PR の状態を取り違えずに導けているか。人の判断の検査と次の一手が使う。
 *
 * 接続済みなら PR の状態を引けている。未設定なら PR がそもそも無いので、手前の列に落ちて見えるカードが無い
 * （途中で設定を外して PR 番号が残ったカードは、そのカードだけを止まりにする。`resolveHold` の `unsetPr`）。
 * 設定があって使えない・エラーのときは、計画レビュー / PR中 のカードが手前の AI の列に落ちて見えうるので偽。
 */
export function forgeTrusted(forge: ForgeConnection): boolean {
  return forge.status === 'connected' || isForgeUnset(forge);
}
