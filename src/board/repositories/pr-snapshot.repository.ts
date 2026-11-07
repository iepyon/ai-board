import type { CardId } from '../../shared/schemas/common.js';
import type { PrSnapshot } from '../models/pr-state.js';

// ============================================================
// PR の状態の控えのリポジトリのインターフェース
// ============================================================

/**
 * `PrFetcher` が引いた PR の状態を、プロセスをまたいで持つ。
 *
 * 書くのは `PrFetcher` だけ（`ai-board status` と `decide`）。ステージの導出の入力ではなく、
 * gh の問い合わせを省くための控えなので、消えても次の問い合わせで引き直すだけで済む。
 */
export interface PrSnapshotRepository {
  /** 読めない行（形の変わった古い控え）は黙って外す */
  findAll(): Promise<Map<CardId, PrSnapshot>>;
  /**
   * マージ済みの PR の控えだけを読む（データ用ブランチの `snapshots/`）。
   * GitHub に届かないときの供給元が使う。マージ済みは二度と変わらないので、古さを気にせずに出せる
   */
  findMerged(): Promise<Map<CardId, PrSnapshot>>;
  save(cardId: CardId, snapshot: PrSnapshot): Promise<void>;
  delete(cardId: CardId): Promise<void>;
}
