import type { CardId } from '../../shared/schemas/common.js';
import type { MrSnapshot } from '../models/mr-state.js';

// ============================================================
// PR の状態の控えのリポジトリのインターフェース
// ============================================================

/**
 * ポーラーが引いた PR の状態を、プロセスをまたいで持つ。
 *
 * 書くのはポーラーだけ（`ai-board status` と `decide`）。ステージの導出の入力ではなく、
 * gh の問い合わせを省くための控えなので、消えても次の問い合わせで引き直すだけで済む。
 */
export interface MrSnapshotRepository {
  /** 読めない行（形の変わった古い控え）は黙って外す */
  findAll(): Promise<Map<CardId, MrSnapshot>>;
  save(cardId: CardId, snapshot: MrSnapshot): Promise<void>;
  delete(cardId: CardId): Promise<void>;
}
