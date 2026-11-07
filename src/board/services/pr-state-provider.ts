import { isAborted, parseReviewLog } from '../../cards/services/review-log.js';
import type {
  ForgeCardFailure,
  ForgeConnection,
  ForgeKind,
  PrSnapshot,
  PrState,
} from '../models/pr-state.js';

// ============================================================
// PR の状態の供給元
// ============================================================

/**
 * ボード描画時にネットワーク I/O をしないための抽象。
 * 実体は `PrFetcher` が持つキャッシュ。
 */
export interface PrStateProvider {
  /** カード ID に対応する PR の状態をキャッシュから返す */
  get(cardId: string): PrState | null;
  connection(): ForgeConnection;
  /**
   * PR の状態を 1 度でも引き終えたか。引き終える前は、PR が無いのか、まだ引いていないのかが分からない。
   * 「PR が見えない」ことを根拠にする判定（`resolveHold` の planLost）は、これが真のときだけ行う
   */
  synced(): boolean;
  /**
   * そのカードの PR を、直近の取得で引けなかったか（全体ではなくそのカードだけの失敗）。引けていれば null。
   * 引けなかったカードの `get` は、前に引けた控えを返す
   */
  failure(cardId: string): ForgeCardFailure | null;
}

/** 取得先が未設定のときの実装。ボードはカードと計画ファイルだけで動く */
export const disabledPrStateProvider: PrStateProvider = {
  get: () => null,
  connection: () => ({ status: 'disabled', kind: null, reason: null }),
  synced: () => false,
  failure: () => null,
};

/**
 * 取得先は設定されているが問い合わせられないときの実装。
 * CLI が入っていない、あるいは未ログイン、ネットワークに届かない場合に使う。
 *
 * `merged` に渡したマージ済みの PR の状態だけを `get` で返す（手元の控え。二度と変わらないので古さを気にしない）。
 * 接続は `disabled` のまま、`synced` も偽のままにするので、次の一手・判断の検査・「PR が見えない」止まりは今までどおり止まる
 */
export function unavailablePrStateProvider(
  kind: ForgeKind,
  reason: string,
  merged: ReadonlyMap<string, PrState> = new Map()
): PrStateProvider {
  return {
    get: (cardId) => merged.get(cardId) ?? null,
    connection: () => ({ status: 'disabled', kind, reason }),
    synced: () => false,
    failure: () => null,
  };
}

/**
 * 控えがもう変わらず、今もそのカードの PR のものか。マージ済みの PR は二度と変わらない。
 *
 * カードの番号が控えの番号と違えば（ブランチを付け替えて番号が外れた・変わった）、控えは古い。
 * マージされずに閉じた PR は reopen されうるので、決まったとはみなさない。
 * `PrFetcher` はこれが真なら引き直さず、届かないときの供給元はこれが真の控えだけを出す
 */
export function isSettled(
  card: { readonly pr: number | null },
  snapshot: PrSnapshot | null
): boolean {
  return snapshot !== null && snapshot.pr.state === 'merged' && card.pr === snapshot.pr.number;
}

/**
 * 中止のカードで、控えが今もそのカードの PR のものか。
 *
 * 中止のカードは、どのステージでも区画が 中止 に固定され（`board-sections.ts` の `sectionOf`）、
 * 判断も作業も待っていないので、PR を引き直しても何にも効かない。
 * 中止かは本文の `## レビュー` だけで決まり、GitHub を引かずに分かる。
 * `PrFetcher` はこれが真なら引き直さず、控えをそのまま使う（控えは消さない）。
 * 控えが無ければ偽で、今どおり一度引いて控えに残す。
 * 中止の後に人が別の判断を書いて最新が 中止 でなくなれば偽に戻り、今どおり引き直す
 */
export function isFrozen(
  card: { readonly pr: number | null; readonly body: string },
  snapshot: PrSnapshot | null
): boolean {
  return (
    snapshot !== null && card.pr === snapshot.pr.number && isAborted(parseReviewLog(card.body))
  );
}

/** 決まった控え（`isSettled`）だけを、カード ID ごとの PR の状態にする。届かないときの供給元に渡す */
export function matchMergedSnapshots(
  cards: readonly { readonly id: string; readonly pr: number | null }[],
  snapshots: ReadonlyMap<string, PrSnapshot>
): Map<string, PrState> {
  const matched = new Map<string, PrState>();
  for (const card of cards) {
    const snapshot = snapshots.get(card.id) ?? null;
    if (snapshot !== null && isSettled(card, snapshot)) matched.set(card.id, snapshot.pr);
  }
  return matched;
}
