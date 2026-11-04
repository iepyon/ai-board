/**
 * カードの区間の並び（タイムライン）の語彙。
 *
 * 区間は、カードがある工程にいた時間を始まりと終わりの時刻で表したもの。
 * 導出はボード（`src/board/services/stage-timeline.ts`）が痕跡から毎回行い、保存しない。
 * 区間の名前と色を画面からも引くので、web からも読める `src/shared/` に置く。
 */

/**
 * 区間の種類。カードの工程の 6 区間に、計画の保留・Draft に戻された後の 2 つを足した 8 種類。
 *
 * 並びは工程の順で、区間の並びの順ではない（差し戻しがあれば同じ種類が何度も現れる）。
 * かつては動作確認の列の 3 つ（`verifying` / `verify-rework` / `verify-held`）と、その承認から始まる `readying` もあったが、列とともに廃止した。
 */
export const TIMELINE_KINDS = [
  'idea',
  'planning',
  'plan-review',
  'plan-rework',
  'plan-held',
  'implementing',
  'pr-review',
  'draft-returned',
] as const;

export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/** 区間の担当。人の判断を待っているか、AI が作業しているか */
export type TimelineOwner = 'human' | 'ai';

/**
 * 区間の種類ごとの担当。
 *
 * 保留は AI が否決を直しきれずに人の判断を待って止まった印なので、人の区間にする。
 * Draft に戻された後も、ループは Ready にし直さず人を待つ（`resolveHold`）ので、人の区間にする。
 */
export const TIMELINE_OWNERS: Record<TimelineKind, TimelineOwner> = {
  idea: 'human',
  planning: 'ai',
  'plan-review': 'human',
  'plan-rework': 'ai',
  'plan-held': 'human',
  implementing: 'ai',
  'pr-review': 'human',
  'draft-returned': 'human',
};

/**
 * 区間 1 つ。時刻は ISO 8601。
 *
 * 今いる区間は `end: null` にする。導出は今の時刻を受け取らないので、
 * 長さを出したい側が `end` が `null` なら `generatedAt` までを数える。
 */
export interface TimelineSegment {
  readonly kind: TimelineKind;
  readonly owner: TimelineOwner;
  readonly start: string;
  readonly end: string | null;
}

/**
 * AI の区間の中の小区間の種類。
 *
 * - `wait`: ループが拾うまでの待ち（区間の中で、どの手も動いていない時間）
 * - `work`: ループが手を進めていた時間（ループの 1 手の記録が重なる時間）
 */
export type TimelinePhaseKind = 'wait' | 'work';

/** AI の区間の中の小区間 1 つ。今も続いていれば `end: null` */
export interface TimelinePhase {
  readonly kind: TimelinePhaseKind;
  readonly start: string;
  readonly end: string | null;
}

/**
 * 小区間を添えた区間。`phases` は時刻の順。
 *
 * 人の区間と、ループの 1 手の記録が 1 つも重ならない AI の区間は、空にする
 * （記録を始める前の区間を、全部「待ち」と言い張らないため）。
 * 分け方は `src/board/services/timeline-phases.ts` の `splitAiPhases`。
 */
export interface PhasedTimelineSegment extends TimelineSegment {
  readonly phases: readonly TimelinePhase[];
}
