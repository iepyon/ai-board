import type { ReviewEntry, ReviewGate, ReviewKind } from '../../cards/models/review.js';
import { TIMELINE_OWNERS, type TimelineKind, type TimelineSegment } from '../../shared/timeline.js';

// ============================================================
// 区間の並び（タイムライン）の導出 — 純関数のみ。I/O は持たない
// ============================================================

/**
 * 区間の導出に使う痕跡。時刻は ISO 8601。
 *
 * `MrState` 全体には依存せず、PR の時刻だけを受け取る。
 * レビューのエントリは `parseReviewLog` で読んだものを、書かれた順のまま渡す。
 */
export interface TimelineTraces {
  readonly created: string;
  readonly startedAt: string | null;
  readonly skipGates: readonly ReviewGate[];
  readonly entries: readonly ReviewEntry[];
  /** PR を最後に Ready にした時刻 */
  readonly readyAt: string | null;
  /** PR をマージした時刻 */
  readonly mergedAt: string | null;
  /** PR を最後に Draft へ戻した時刻（今 open かつ Draft のときだけ値を持つ） */
  readonly convertedToDraftAt: string | null;
}

/** 区間を閉じるだけで、次の区間を始めない */
const CLOSE = 'close';

type Transition = TimelineKind | typeof CLOSE;

/**
 * `## レビュー` のエントリ 1 件が始める区間。(ゲート, 種別) をキーにして引く。
 *
 * `verify 承認` の `readying` は、その時点で PR が Ready なら `pr-review` に読み替える（`resolveNext`）。
 */
const REVIEW_TRANSITIONS = {
  'plan:提出': 'plan-review',
  'plan:再提出': 'plan-review',
  'plan:否決': 'plan-rework',
  'plan:保留': 'plan-held',
  'plan:承認': 'implementing',
  'plan:中止': CLOSE,
  'verify:提出': 'verifying',
  'verify:再提出': 'verifying',
  'verify:否決': 'verify-rework',
  'verify:保留': 'verify-held',
  'verify:承認': 'readying',
  'verify:中止': CLOSE,
} as const satisfies Record<`${ReviewGate}:${ReviewKind}`, Transition>;

/**
 * 痕跡 1 つ。`rank` は同じ時刻の痕跡を並べる順
 * （起票 → 着手 → `## レビュー` のエントリ → Ready → Draft へ戻す → マージ）。
 * エントリどうしは書かれた順のまま残す（`Array.prototype.sort` は安定）。
 */
interface Trace {
  readonly at: string;
  readonly time: number;
  readonly rank: number;
  readonly next: Transition;
  /** この痕跡で PR が Ready になったか（true）、Draft に戻ったか（false）。変わらなければ undefined */
  readonly prReady?: boolean;
  /** マージ。ここで読むのをやめる */
  readonly stop?: boolean;
}

/**
 * カードの痕跡から、区間の並びを時刻の順に返す純関数。
 *
 * 痕跡を 1 つの列に並べて時刻の順に読み、各痕跡が次の区間の種類を決めて、そこまでの区間を閉じる。
 * `## レビュー` は全部のエントリを読む（`currentEntries` は通さない）。
 * 「計画から立て直させる」のように、今は効いていない古いエントリこそが区間の境目になるため。
 *
 * 並びは次を満たす。
 *
 * - 時刻の順に並び、隣り合う区間の `end` と次の `start` が等しい（中止の後に続いたエントリから始め直すときだけ隙間が空く）
 * - 長さ 0 の区間は落とし、同じ種類の区間が隣り合ったら 1 つにつなぐ
 * - 今いる区間だけが `end: null`。マージ・中止で終わったカードは持たない
 *
 * 導出は今の時刻を受け取らない。長さを出したい側が `end: null` を今までとして数える。
 */
export function resolveTimeline(traces: TimelineTraces): TimelineSegment[] {
  return normalize(walk(toTraces(traces)));
}

// ------------------------------------------------------------
// 痕跡を並べる
// ------------------------------------------------------------

function toTraces(traces: TimelineTraces): Trace[] {
  const list: Trace[] = [trace(traces.created, 0, 'idea')];

  const startedAt = effectiveStartedAt(traces);
  if (startedAt !== null) {
    list.push(trace(startedAt, 1, traces.skipGates.includes('plan') ? 'implementing' : 'planning'));
  }

  for (const entry of traces.entries) {
    list.push(trace(entry.at, 2, REVIEW_TRANSITIONS[`${entry.gate}:${entry.kind}`]));
  }

  if (traces.readyAt !== null) {
    list.push({ ...trace(traces.readyAt, 3, 'pr-review'), prReady: true });
  }
  if (traces.convertedToDraftAt !== null) {
    list.push({ ...trace(traces.convertedToDraftAt, 4, 'draft-returned'), prReady: false });
  }
  if (traces.mergedAt !== null) {
    list.push({ ...trace(traces.mergedAt, 5, CLOSE), stop: true });
  }

  return list
    .filter((item) => !Number.isNaN(item.time))
    .sort((a, b) => a.time - b.time || a.rank - b.rank);
}

function trace(at: string, rank: number, next: Transition): Trace {
  return { at, time: Date.parse(at), rank, next };
}

/**
 * 区間の始まりに使う着手の時刻。
 *
 * 着手のボタンを押さずに進めたカードは `startedAt` が無い。最初のエントリより後の `startedAt` は
 * 通常の操作からは生まれない（DB を直接書き換えたか、古いデータを取り込んだとき）。
 * どちらも着手を無いものとして扱い、`idea` が最初の痕跡まで続く。
 */
function effectiveStartedAt({ startedAt, entries }: TimelineTraces): string | null {
  if (startedAt === null) return null;

  const firstEntry = Math.min(...entries.map((entry) => Date.parse(entry.at)));

  return Date.parse(startedAt) > firstEntry ? null : startedAt;
}

// ------------------------------------------------------------
// 痕跡を読んで区間にする
// ------------------------------------------------------------

interface OpenSegment {
  readonly kind: TimelineKind;
  readonly start: string;
}

function walk(traces: readonly Trace[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let current = null as OpenSegment | null;
  let prReady = false;

  for (const item of traces) {
    prReady = item.prReady ?? prReady;
    const next = resolveNext(item.next, prReady);

    if (current?.kind === next) continue;

    if (current !== null) segments.push(toSegment(current, item.at));
    current = next === CLOSE ? null : { kind: next, start: item.at };

    if (item.stop === true) break;
  }

  if (current !== null) segments.push(toSegment(current, null));

  return segments;
}

/** verify 承認の時点で PR がもう Ready なら、Ready にする区間を飛ばして PR レビューへ進む */
function resolveNext(next: Transition, prReady: boolean): Transition {
  return next === 'readying' && prReady ? 'pr-review' : next;
}

function toSegment(open: OpenSegment, end: string | null): TimelineSegment {
  return { kind: open.kind, owner: TIMELINE_OWNERS[open.kind], start: open.start, end };
}

/** 長さ 0 の区間を落とし、そのあと隣り合った同じ種類の区間を 1 つにつなぐ */
function normalize(segments: readonly TimelineSegment[]): TimelineSegment[] {
  const result: TimelineSegment[] = [];

  for (const segment of segments) {
    if (segment.end !== null && Date.parse(segment.end) === Date.parse(segment.start)) continue;

    const last = result.at(-1);
    if (last !== undefined && canJoin(last, segment)) {
      result[result.length - 1] = { ...last, end: segment.end };
      continue;
    }

    result.push(segment);
  }

  return result;
}

function canJoin(prev: TimelineSegment, next: TimelineSegment): boolean {
  return (
    prev.kind === next.kind && prev.end !== null && Date.parse(prev.end) === Date.parse(next.start)
  );
}
