import type { MrState, GitLabConnection } from '../models/mr-state.js';

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
  connection(): GitLabConnection;
}

/** GitLab 未設定時の実装。ボードは openspec 由来の情報だけで動く */
export const disabledMrStateProvider: MrStateProvider = {
  get: () => null,
  connection: () => ({ status: 'disabled' }),
};
