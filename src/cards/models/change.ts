import type { CardId } from '../../shared/schemas/common.js';
import type { Card } from './card.js';

// ============================================================
// データのマイグレーション — カードの変更を操作として表す
// ============================================================

/**
 * カードに書く列。`id` 以外の列を、変わったものだけ持つ。
 * キーが無い列は変えない。`null` を持つ列は値を消す。
 */
export type CardFieldChanges = Partial<Omit<Card, 'id'>>;

/**
 * 変更ファイル（`.ai-board/changes/*.yaml`）の 1 操作。
 *
 * SQL ではなく操作で書くのは、スキーマを変えても古いファイルを流せるようにするため。
 * 反映はリポジトリを通すので、列の変更はリポジトリの実装の側で吸収できる。
 */
export type ChangeOp =
  | {
      readonly kind: 'card';
      readonly id: CardId;
      /** カードが無ければ作る。そのときは `title` と `created` が要る */
      readonly set: CardFieldChanges;
    }
  | {
      readonly kind: 'divider';
      /** アイデアの表の区切り線の rank */
      readonly rank: number;
    };

/** 変更ファイル 1 つ。名前の順が適用の順になる */
export interface ChangeFile {
  readonly name: string;
  readonly ops: readonly ChangeOp[];
}

/** 変更を流す対象の状態。カードと区切り線だけを持つ */
export interface BoardSnapshot {
  readonly cards: ReadonlyMap<CardId, Card>;
  readonly divider: number | null;
}

export const EMPTY_SNAPSHOT: BoardSnapshot = { cards: new Map(), divider: null };
