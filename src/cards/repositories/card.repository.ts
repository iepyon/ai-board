import type { CardId } from '../../shared/schemas/common.js';
import type { Card } from '../models/card.js';
import type { ReviewEntry } from '../models/review.js';

// ============================================================
// カードリポジトリのインターフェース
// ============================================================

/**
 * 実装はデータのワークツリーのファイル（`FileCardRepository`）。
 * usecase はこのインターフェースにのみ依存する。
 */
export interface CardRepository {
  /** 壊れたファイルは警告として skip し、読めたカードだけを並び順（`compareCards`）で返す */
  findAll(): Promise<Card[]>;
  findById(id: CardId): Promise<Card | null>;
  /** 既存 ID があれば false を返し、何も書かない */
  create(card: Card): Promise<boolean>;
  /** 存在しなければ false を返す */
  save(card: Card): Promise<boolean>;
  /**
   * 判断を 1 件、値のまま足す。存在しなければ false を返し、何も書かない。
   * 理由はそのまま記録するだけで、判断の見出しとして読み直さない
   */
  appendReview(id: CardId, entry: ReviewEntry): Promise<boolean>;
}
