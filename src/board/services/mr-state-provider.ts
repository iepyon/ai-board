import type { ForgeConnection, ForgeKind, MrState } from '../models/mr-state.js';

// ============================================================
// MR 状態の供給元
// ============================================================

/**
 * ボード描画時にネットワーク I/O をしないための抽象。
 * 実体はバックグラウンドポーラーが持つキャッシュ。
 */
export interface MrStateProvider {
  /** カード ID に対応する MR 状態をキャッシュから返す */
  get(cardId: string): MrState | null;
  connection(): ForgeConnection;
}

/** 取得先が未設定のときの実装。ボードは openspec 由来の情報だけで動く */
export const disabledMrStateProvider: MrStateProvider = {
  get: () => null,
  connection: () => ({ status: 'disabled', kind: null, reason: null }),
};

/**
 * 取得先は設定されているが問い合わせられないときの実装。
 * CLI が入っていない、あるいは未ログインの場合に使う。
 */
export function unavailableMrStateProvider(kind: ForgeKind, reason: string): MrStateProvider {
  return {
    get: () => null,
    connection: () => ({ status: 'disabled', kind, reason }),
  };
}
