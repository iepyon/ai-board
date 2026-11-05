import type { ForgeCardFailure, ForgeConnection, ForgeKind, MrState } from '../models/mr-state.js';

// ============================================================
// PR の状態の供給元
// ============================================================

/**
 * ボード描画時にネットワーク I/O をしないための抽象。
 * 実体はバックグラウンドポーラーが持つキャッシュ。
 */
export interface MrStateProvider {
  /** カード ID に対応する PR の状態をキャッシュから返す */
  get(cardId: string): MrState | null;
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
export const disabledMrStateProvider: MrStateProvider = {
  get: () => null,
  connection: () => ({ status: 'disabled', kind: null, reason: null }),
  synced: () => false,
  failure: () => null,
};

/**
 * 取得先は設定されているが問い合わせられないときの実装。
 * CLI が入っていない、あるいは未ログインの場合に使う。
 */
export function unavailableMrStateProvider(kind: ForgeKind, reason: string): MrStateProvider {
  return {
    get: () => null,
    connection: () => ({ status: 'disabled', kind, reason }),
    synced: () => false,
    failure: () => null,
  };
}
