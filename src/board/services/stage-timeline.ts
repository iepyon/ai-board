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
  /** 飛ばす宣言のあるゲート。そのゲートの 提出 / 再提出 を 承認 と同じに読む（`transitionOf`） */
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
 * 飛ばす宣言のあるゲートの 提出 / 再提出 は、引く前に 承認 に読み替える（`transitionOf`）。
 * 廃止した `verify` ゲートのエントリは `parseReviewLog` が読み飛ばすので、ここには来ない。
 * 動作確認の区間を持っていたマージ済みのカードも、実装から PR レビューへ直に続く区間として読む。
 */
const REVIEW_TRANSITIONS = {
  'plan:提出': 'plan-review',
  'plan:再提出': 'plan-review',
  'plan:差し戻し': 'plan-rework',
  'plan:保留': 'plan-held',
  'plan:承認': 'implementing',
  'plan:中止': CLOSE,
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
  /** PR の痕跡（Ready にした・Draft へ戻した）か。中止で閉じた後はこの痕跡では区間を開かない */
  readonly pr?: true;
  /** マージ。ここで読むのをやめる */
  readonly stop?: boolean;
}

/**
 * カードの痕跡から、区間の並びを時刻の順に返す純関数。
 *
 * 痕跡を 1 つの列に並べて時刻の順に読み、各痕跡が次の区間の種類を決めて、そこまでの区間を閉じる。
 * `## レビュー` は全部のエントリを読む（今効いている最新だけに絞らない）。
 * 「計画から立て直させる」のように、今は効いていない古いエントリこそが区間の境目になるため。
 * 着手は飛ばす宣言によらず `planning` を始める（plan を飛ばすカードでも、着手してから AI が計画を書く）。
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
    list.push(trace(startedAt, 1, 'planning'));
  }

  for (const entry of traces.entries) {
    list.push(trace(entry.at, 2, transitionOf(entry, traces.skipGates)));
  }

  if (traces.readyAt !== null) {
    list.push({ ...trace(traces.readyAt, 3, 'pr-review'), pr: true });
  }
  if (traces.convertedToDraftAt !== null) {
    list.push({ ...trace(traces.convertedToDraftAt, 4, 'draft-returned'), pr: true });
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
 * エントリ 1 件が始める区間。
 *
 * 飛ばす宣言のあるゲートの 提出 / 再提出 は、`gateState` と同じく人の 承認 と読む。
 * plan の 提出 / 再提出 は `implementing` を始める。
 */
function transitionOf({ gate, kind }: ReviewEntry, skipGates: readonly ReviewGate[]): Transition {
  const passes = (kind === '提出' || kind === '再提出') && skipGates.includes(gate);

  return REVIEW_TRANSITIONS[`${gate}:${passes ? '承認' : kind}`];
}

/**
 * 区間の始まりに使う着手の時刻。
 *
 * 着手を書かずに進めたカードは `startedAt` が無い。最初のエントリより後の `startedAt` は
 * 通常の操作からは生まれない（データ用ブランチを手で書き換えたか、古いデータを取り込んだとき）。
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

/**
 * 痕跡を時刻の順に読み、区間を閉じては次の区間を始める。
 *
 * 中止で閉じた後は、`## レビュー` のエントリが来て区間を始め直すまで、PR の痕跡（Ready・Draft へ戻す）では区間を開かない。
 * 中止で終わったカードに `end: null` を残さないためである。
 */
function walk(traces: readonly Trace[]): TimelineSegment[] {
  const segments: TimelineSegment[] = [];
  let current = null as OpenSegment | null;
  let closed = false;

  for (const item of traces) {
    if (closed && item.pr === true) continue;
    if (current?.kind === item.next) continue;

    if (current !== null) segments.push(toSegment(current, item.at));
    current = item.next === CLOSE ? null : { kind: item.next, start: item.at };
    closed = current === null;

    if (item.stop === true) break;
  }

  if (current !== null) segments.push(toSegment(current, null));

  return segments;
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
