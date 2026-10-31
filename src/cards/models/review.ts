// ============================================================
// レビューログ — 人の判断を残す唯一の場所
// ============================================================

/**
 * 人が判断するゲート。
 *
 * `pr` ゲートはここに含めない。PR の承認は GitHub 側の実態
 * （PR が merged になること）そのものであり、カード本文には現れないため。
 *
 * - `plan`   計画を読んで確かめる（計画レビューの列）
 * - `verify` 実装を動かして確かめる（動作確認の列）
 *
 * かつては `explore` ゲートもあったが、探索レビューの列とともに廃止した。
 * 既存カードに残る `explore` のエントリは規定外のゲートとして黙って無視される。
 */
export const REVIEW_GATES = ['plan', 'verify'] as const;

export type ReviewGate = (typeof REVIEW_GATES)[number];

/**
 * レビューエントリの種別。
 *
 * - 提出 / 再提出 / 保留 は AI が書く。保留は、AI がその手を自分では進められないと判断して止まった痕跡
 * - 承認 / 否決 / 中止 は人が書く（`HUMAN_REVIEW_KINDS`）
 */
export const REVIEW_KINDS = ['提出', '再提出', '保留', '承認', '否決', '中止'] as const;

export type ReviewKind = (typeof REVIEW_KINDS)[number];

/** 人が画面（`POST /api/cards/:id/reviews`）から書ける種別。AI の種別はここに含めない */
export const HUMAN_REVIEW_KINDS = ['承認', '否決', '中止'] as const satisfies readonly ReviewKind[];

export type HumanReviewKind = (typeof HUMAN_REVIEW_KINDS)[number];

export interface ReviewEntry {
  /** ISO 8601 文字列 */
  readonly at: string;
  readonly gate: ReviewGate;
  readonly kind: ReviewKind;
  /** 見出しに続く本文。理由が書かれていなければ空文字 */
  readonly reason: string;
}

/**
 * ゲートの通過状況。ステージ導出の入力になる。
 *
 * `held` は AI が保留を書いて止まった状態。どの規則も `held` でゲートを先へ進めないので、
 * カードは AI の列（計画提案中 / 実装中）に留まり、人の判断を待つ。
 */
export type GateState = 'none' | 'submitted' | 'held' | 'approved' | 'rejected';

export function isReviewGate(value: string): value is ReviewGate {
  return (REVIEW_GATES as readonly string[]).includes(value);
}

export function isReviewKind(value: string): value is ReviewKind {
  return (REVIEW_KINDS as readonly string[]).includes(value);
}
