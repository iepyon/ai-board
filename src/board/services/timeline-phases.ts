import type {
  PhasedTimelineSegment,
  TimelinePhase,
  TimelineSegment,
} from '../../shared/timeline.js';

// ============================================================
// AI の区間を「待ち」と「作業」に分ける純関数
// ============================================================

/** 1 手の記録のうち、分け方に要るものだけ。終わっていなければ `finishedAt: null` */
export interface PhaseStep {
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

/** 時刻を数にしたもの。`end` が Infinity なら今も続いている */
interface Span {
  readonly start: number;
  readonly end: number;
}

/**
 * 区間の並び（`resolveTimeline` の結果）に、ループの 1 手の記録から小区間を添える。
 *
 * - 人の区間の `phases` は空
 * - AI の区間では、そのカードの記録を区間の範囲で切り取り、重なった部分を `work`、区間の中のそれ以外を `wait` にする
 * - 区間に重なる記録が 1 つも無ければ `phases` を空にする
 * - 記録どうしが重なれば 1 つの `work` につなぐ
 * - 終わっていない区間・終わっていない記録は `end: null` のまま扱い、今の時刻は受け取らない（`resolveTimeline` と同じ）
 *
 * `steps` は 1 枚のカードの記録。区間の導出（痕跡だけから決まる）とは分け、`resolveTimeline` には手を入れない。
 */
export function splitAiPhases(
  segments: readonly TimelineSegment[],
  steps: readonly PhaseStep[]
): PhasedTimelineSegment[] {
  const spans = steps
    .map(toSpan)
    .filter((span): span is Span => span !== null)
    .sort((a, b) => a.start - b.start);

  return segments.map((segment) => ({
    ...segment,
    phases: segment.owner === 'ai' ? phasesOf(segment, spans) : [],
  }));
}

function phasesOf(segment: TimelineSegment, spans: readonly Span[]): TimelinePhase[] {
  const range = toSpan({ startedAt: segment.start, finishedAt: segment.end });
  if (range === null) return [];

  const work = mergeSpans(
    spans
      .map((span) => ({
        start: Math.max(span.start, range.start),
        end: Math.min(span.end, range.end),
      }))
      .filter((span) => span.start < span.end)
  );
  if (work.length === 0) return [];

  const phases: TimelinePhase[] = [];
  let cursor = range.start;
  for (const span of work) {
    if (span.start > cursor) phases.push(phase('wait', cursor, span.start));
    phases.push(phase('work', span.start, span.end));
    cursor = span.end;
  }
  if (cursor < range.end) phases.push(phase('wait', cursor, range.end));

  return phases;
}

/** 開始の順に並んだ範囲のうち、重なるか接するものをつなぐ */
function mergeSpans(spans: readonly Span[]): Span[] {
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last !== undefined && span.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
    } else {
      merged.push(span);
    }
  }
  return merged;
}

function toSpan(step: PhaseStep): Span | null {
  const start = Date.parse(step.startedAt);
  const end = step.finishedAt === null ? Infinity : Date.parse(step.finishedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return { start, end };
}

function phase(kind: TimelinePhase['kind'], start: number, end: number): TimelinePhase {
  return {
    kind,
    start: new Date(start).toISOString(),
    end: end === Infinity ? null : new Date(end).toISOString(),
  };
}
