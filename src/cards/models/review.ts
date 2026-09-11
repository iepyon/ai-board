// ============================================================
// レビューログ — 人の判断を残す唯一の場所
// ============================================================

/**
 * 人が判断するゲート。
 *
 * `pr` ゲートはここに含めない。PR の承認は GitLab 側の実態
 * （MR が merged になること）そのものであり、カード本文には現れないため。
 *
 * かつては `explore` ゲートもあったが、探索レビューの列とともに廃止した。
 * 既存カードに残る `explore` のエントリは規定外のゲートとして黙って無視される。
 */
export const REVIEW_GATES = ['plan'] as const;

export type ReviewGate = (typeof REVIEW_GATES)[number];

/** レビューエントリの種別。提出 / 再提出 は AI、それ以外は人が書く */
export const REVIEW_KINDS = ['提出', '再提出', '承認', '否決', '中止'] as const;

export type ReviewKind = (typeof REVIEW_KINDS)[number];

export interface ReviewEntry {
  /** ISO 8601 文字列 */
  readonly at: string;
  readonly gate: ReviewGate;
  readonly kind: ReviewKind;
  /** 見出しに続く本文。理由が書かれていなければ空文字 */
  readonly reason: string;
}

/** ゲートの通過状況。ステージ導出の入力になる */
export type GateState = 'none' | 'submitted' | 'approved' | 'rejected';

export function isReviewGate(value: string): value is ReviewGate {
  return (REVIEW_GATES as readonly string[]).includes(value);
}

export function isReviewKind(value: string): value is ReviewKind {
  return (REVIEW_KINDS as readonly string[]).includes(value);
}
