import type { CardId } from '../../shared/schemas/common.js';
import type { ForgeKind, MrSnapshot } from '../models/mr-state.js';
import type { MrStateProvider } from './mr-state-provider.js';

// ============================================================
// 控えだけから PR の状態を返す供給元
// ============================================================

/**
 * `ai-board status` などの CLI が最後に書いた PR の状態の控えだけを読み、GitHub には問い合わせない。
 *
 * `ai-board serve` の API のサンプルが使う。PR の状態は最後に CLI を動かした時点のもので、
 * 接続は「設定されていて、控えを読んでいる」として `connected` を返す（`decisionsFor` と `resolveHold` が読む）。
 * 控えが 1 件も無ければ、PR が無いのか引いていないのかが分からないので `synced` を偽にする。
 */
export function createSnapshotMrStateProvider(
  kind: ForgeKind,
  snapshots: ReadonlyMap<CardId, MrSnapshot>
): MrStateProvider {
  return {
    get: (cardId) => snapshots.get(cardId as CardId)?.mr ?? null,
    connection: () => ({ status: 'connected', kind }),
    synced: () => snapshots.size > 0,
    failure: () => null,
  };
}
