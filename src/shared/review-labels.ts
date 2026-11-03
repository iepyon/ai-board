/** 判断のゲート（`plan`）。`src/web/types.ts` の `ReviewGate` と同じ */
export type ReviewLabelGate = 'plan';

/** 判断の種別。`src/web/types.ts` の `ReviewKind` と同じ */
export type ReviewLabelKind = '提出' | '再提出' | '保留' | '承認' | '否決' | '中止';

/** 詳細パネルの「判断の記録」で、判断の見出しに出すゲートの名前 */
export const REVIEW_GATE_LABELS: Record<ReviewLabelGate, string> = {
  plan: '計画',
};

/**
 * 判断の見出しの色の分け方。
 * 人の判断（承認 / 否決 / 中止）は結果ごとに、AI の提出と再提出は 1 つにまとめ、保留は人を待つ止まりとして分ける。
 */
export type ReviewTone = 'approve' | 'reject' | 'abort' | 'submit' | 'hold';

const TONES: Record<ReviewLabelKind, ReviewTone> = {
  承認: 'approve',
  否決: 'reject',
  中止: 'abort',
  提出: 'submit',
  再提出: 'submit',
  保留: 'hold',
};

export function reviewTone(kind: ReviewLabelKind): ReviewTone {
  return TONES[kind];
}
