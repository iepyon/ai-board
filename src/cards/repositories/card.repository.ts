import type { CardId } from '../../shared/schemas/common.js';
import type { Card } from '../models/card.js';

// ============================================================
// カードリポジトリのインターフェース
// ============================================================

/**
 * 実装は `.ai-board/cards/` 配下の Markdown ファイル。
 * usecase はこのインターフェースにのみ依存する。
 */
export interface CardRepository {
  /** 壊れたファイルは警告として skip し、読めたカードだけを返す */
  findAll(): Promise<Card[]>;
  findById(id: CardId): Promise<Card | null>;
  /** 既存 ID があれば false を返し、何も書かない */
  create(card: Card): Promise<boolean>;
  /** 存在しなければ false を返す */
  save(card: Card): Promise<boolean>;
}
