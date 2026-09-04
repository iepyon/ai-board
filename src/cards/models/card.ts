import type { CardId, ChangeName, MergeRequestIid, Stage } from '../../shared/schemas/common.js';

// ============================================================
// カード — アイデアから DONE までを貫く唯一の join テーブル
// ============================================================

/**
 * カードは `.ai-board/cards/<id>.md` の 1 ファイルに対応する。
 *
 * `id` は不変で、`change` / `branch` / `mr` が進行に応じて後から埋まる。
 * カードは全ステージを通じて存在し続ける（done でも削除しない）ため、
 * アイデアメモ → change → ブランチ → MR → archive を 1 本の線でつなげる。
 */
export interface Card {
  readonly id: CardId;
  readonly title: string;
  /** ISO 8601 文字列 */
  readonly created: string;
  /** explored ステージへ昇格させる明示フラグ */
  readonly explored: boolean;
  /** impling ステージへ昇格させる明示マーカー（打刻時刻の ISO 8601 文字列） */
  readonly implStartedAt: string | null;
  readonly change: ChangeName | null;
  readonly branch: string | null;
  readonly mr: MergeRequestIid | null;
  /** ステージの手動上書き。null なら自動導出に従う */
  readonly stageOverride: Stage | null;
  /** frontmatter を除いた Markdown 本文 */
  readonly body: string;
}
