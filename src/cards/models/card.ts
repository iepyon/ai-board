import type { CardId, ChangeName, MergeRequestIid } from '../../shared/schemas/common.js';
import type { ReviewGate } from './review.js';

// ============================================================
// カード — アイデアから マージ済み までを貫く唯一の join テーブル
// ============================================================

/**
 * カードは `.ai-board/cards/<id>.md` の 1 ファイルに対応する。
 *
 * `id` は不変で、`change` / `branch` / `mr` が進行に応じて後から埋まる。
 * カードは全ステージを通じて存在し続ける（マージ済みでも削除しない）ため、
 * アイデアメモ → change → ブランチ → MR → archive を 1 本の線でつなげる。
 *
 * ステージそのものは保存しない。`startedAt` と本文のレビューログ、
 * および openspec / GitLab の実態から純関数で導出する。
 */
export interface Card {
  readonly id: CardId;
  readonly title: string;
  /** ISO 8601 文字列 */
  readonly created: string;
  /** 人が探索の着手を指示した時刻。null ならアイデア列に留まる */
  readonly startedAt: string | null;
  /** 人が事前に「見ない」と宣言したゲート。AI はここで止まらない */
  readonly skipGates: readonly ReviewGate[];
  readonly change: ChangeName | null;
  readonly branch: string | null;
  readonly mr: MergeRequestIid | null;
  /** frontmatter を除いた Markdown 本文。レビューログと探索メモを含む */
  readonly body: string;
}
