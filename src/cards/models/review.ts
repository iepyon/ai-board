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
 *
 * かつては `explore` ゲート（探索レビューの列）と `verify` ゲート（動作確認の列）もあったが、どちらも列とともに廃止した。
 * 実装を動かして確かめるのは、AI が PR の本文に書いた証拠を読んで PR中 で行う。
 * 既存カードに残る `explore` / `verify` のエントリは規定外のゲートとして黙って無視される（記録は消さない）。
 */
export const REVIEW_GATES = ['plan'] as const;

export type ReviewGate = (typeof REVIEW_GATES)[number];

/**
 * 廃止したゲート。カードに残る記録（`## レビュー` のエントリ、判断のファイル、`skipGates`）を、
 * 警告もエラーも出さずに読み飛ばすために使う。書く入口はどれも受け付けない。
 */
export const RETIRED_REVIEW_GATES = ['explore', 'verify'] as const;

/**
 * レビューエントリの種別。
 *
 * - 提出 / 再提出 / 保留 は AI が書く。保留は、AI がその手を自分では進められないと判断して止まった痕跡
 * - 承認 / 否決 / 中止 は人が書く（`ai-board decide`）
 */
export const REVIEW_KINDS = ['提出', '再提出', '保留', '承認', '否決', '中止'] as const;

export type ReviewKind = (typeof REVIEW_KINDS)[number];

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

/** 廃止したゲートか。記録を読むときに、壊れた値ではなく黙って読み飛ばしてよいものかを決める */
export function isRetiredReviewGate(value: string): boolean {
  return (RETIRED_REVIEW_GATES as readonly string[]).includes(value);
}

export function isReviewKind(value: string): value is ReviewKind {
  return (REVIEW_KINDS as readonly string[]).includes(value);
}
