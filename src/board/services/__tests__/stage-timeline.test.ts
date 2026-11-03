import { describe, it, expect } from 'vitest';
import { resolveTimeline, type TimelineTraces } from '../stage-timeline.js';
import type { ReviewEntry, ReviewGate, ReviewKind } from '../../../cards/models/review.js';
import { TIMELINE_OWNERS, type TimelineSegment } from '../../../shared/timeline.js';

// ============================================================
// テストデータビルダー
// ============================================================

/** 2026-10-01 の `hour` 時の ISO 8601 */
function at(hour: number): string {
  return new Date(Date.UTC(2026, 9, 1, hour)).toISOString();
}

function entry(hour: number, gate: ReviewGate, kind: ReviewKind): ReviewEntry {
  return { at: at(hour), gate, kind, reason: '' };
}

function makeTraces(overrides: Partial<TimelineTraces> = {}): TimelineTraces {
  return {
    created: at(0),
    startedAt: null,
    skipGates: [],
    entries: [],
    readyAt: null,
    mergedAt: null,
    convertedToDraftAt: null,
    ...overrides,
  };
}

/** 区間を `[種類, 始まり（時）, 終わり（時 | null）]` の形にする */
function shape(segments: readonly TimelineSegment[]): [string, number, number | null][] {
  const hour = (iso: string): number => (Date.parse(iso) - Date.parse(at(0))) / 3_600_000;

  return segments.map((segment) => [
    segment.kind,
    hour(segment.start),
    segment.end === null ? null : hour(segment.end),
  ]);
}

/**
 * 並びの決まりを確かめる。
 *
 * - 担当は種類から決まる
 * - 時刻の順に並び、隣り合う区間の `end` と次の `start` が等しい
 *   （`gapsAt` に挙げた時刻＝中止の後に続いたエントリだけは、隙間を空けて始まってよい）
 * - 長さが 0 以下の区間が無い。同じ種類の区間が、隙間なく隣り合っていない
 * - `end: null` は最後の区間だけ。閉じたカードは持たない
 */
function expectWellFormed(
  segments: readonly TimelineSegment[],
  { closed, gapsAt = [] }: { closed: boolean; gapsAt?: readonly string[] }
): void {
  segments.forEach((segment, index) => {
    expect(segment.owner).toBe(TIMELINE_OWNERS[segment.kind]);

    const isLast = index === segments.length - 1;
    if (segment.end === null) {
      expect(isLast).toBe(true);
    } else {
      expect(Date.parse(segment.end)).toBeGreaterThan(Date.parse(segment.start));
    }

    const prev = segments[index - 1];
    if (prev === undefined) return;

    expect(prev.end).not.toBeNull();
    const prevEnd = Date.parse(prev.end ?? '');
    const start = Date.parse(segment.start);

    if (gapsAt.some((gap) => Date.parse(gap) === start)) {
      expect(start).toBeGreaterThanOrEqual(prevEnd);
    } else {
      expect(start).toBe(prevEnd);
      expect(segment.kind).not.toBe(prev.kind);
    }
  });

  if (closed) {
    expect(segments.at(-1)?.end).not.toBeNull();
  } else {
    expect(segments.at(-1)?.end).toBeNull();
  }
}

// ============================================================
// 工程を順に進む
// ============================================================

describe('resolveTimeline: 工程を順に進む', () => {
  it('アイデアのまま: 起票からの idea が 1 区間だけ開いている', () => {
    const segments = resolveTimeline(makeTraces());

    expect(shape(segments)).toEqual([['idea', 0, null]]);
    expectWellFormed(segments, { closed: false });
  });

  it('着手したまま: idea が着手で閉じ、planning が開いている', () => {
    const segments = resolveTimeline(makeTraces({ startedAt: at(1) }));

    expect(shape(segments)).toEqual([
      ['idea', 0, 1],
      ['planning', 1, null],
    ]);
    expectWellFormed(segments, { closed: false });
  });

  it('計画レビュー中: plan 提出から plan-review が開いている', () => {
    const segments = resolveTimeline(
      makeTraces({ startedAt: at(1), entries: [entry(2, 'plan', '提出')] })
    );

    expect(shape(segments)).toEqual([
      ['idea', 0, 1],
      ['planning', 1, 2],
      ['plan-review', 2, null],
    ]);
    expectWellFormed(segments, { closed: false });
  });

  it('計画の否決と再提出: plan-review → plan-rework → plan-review', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [entry(2, 'plan', '提出'), entry(3, 'plan', '否決'), entry(4, 'plan', '再提出')],
      })
    );

    expect(shape(segments)).toEqual([
      ['idea', 0, 1],
      ['planning', 1, 2],
      ['plan-review', 2, 3],
      ['plan-rework', 3, 4],
      ['plan-review', 4, null],
    ]);
    expectWellFormed(segments, { closed: false });
  });

  it('計画の保留: 否決を直しきれずに保留すると plan-held（人）になる', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [entry(2, 'plan', '提出'), entry(3, 'plan', '否決'), entry(4, 'plan', '保留')],
      })
    );

    expect(shape(segments)).toEqual([
      ['idea', 0, 1],
      ['planning', 1, 2],
      ['plan-review', 2, 3],
      ['plan-rework', 3, 4],
      ['plan-held', 4, null],
    ]);
    expect(segments.at(-1)?.owner).toBe('human');
    expectWellFormed(segments, { closed: false });
  });

  it('実装中: plan 承認から implementing が開いている', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [entry(2, 'plan', '提出'), entry(3, 'plan', '承認')],
      })
    );

    expect(shape(segments)).toEqual([
      ['idea', 0, 1],
      ['planning', 1, 2],
      ['plan-review', 2, 3],
      ['implementing', 3, null],
    ]);
    expectWellFormed(segments, { closed: false });
  });

  it('マージ済み: implementing が Ready で閉じ、pr-review がマージで閉じ、マージの後の痕跡は読まない', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [entry(2, 'plan', '提出'), entry(3, 'plan', '承認'), entry(9, 'plan', '否決')],
        readyAt: at(6),
        mergedAt: at(7),
      })
    );

    expect(shape(segments)).toEqual([
      ['idea', 0, 1],
      ['planning', 1, 2],
      ['plan-review', 2, 3],
      ['implementing', 3, 6],
      ['pr-review', 6, 7],
    ]);
    expectWellFormed(segments, { closed: true });
  });
});

// ============================================================
// 差し戻し・中止
// ============================================================

describe('resolveTimeline: 差し戻しと中止', () => {
  it('計画から立て直させる: 承認済みの計画への否決で implementing に戻り直す', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [
          entry(2, 'plan', '提出'),
          entry(3, 'plan', '承認'),
          entry(5, 'plan', '否決'),
          entry(6, 'plan', '再提出'),
          entry(7, 'plan', '承認'),
        ],
      })
    );

    expect(shape(segments).slice(3)).toEqual([
      ['implementing', 3, 5],
      ['plan-rework', 5, 6],
      ['plan-review', 6, 7],
      ['implementing', 7, null],
    ]);
    expectWellFormed(segments, { closed: false });
  });

  it('中止: 今の区間を閉じ、次の区間を始めない', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [entry(2, 'plan', '提出'), entry(3, 'plan', '中止')],
      })
    );

    expect(shape(segments)).toEqual([
      ['idea', 0, 1],
      ['planning', 1, 2],
      ['plan-review', 2, 3],
    ]);
    expectWellFormed(segments, { closed: true });
  });

  it('中止の後にエントリが続く: そのエントリから区間を再び始める', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [entry(2, 'plan', '提出'), entry(3, 'plan', '中止'), entry(5, 'plan', '否決')],
      })
    );

    expect(shape(segments)).toEqual([
      ['idea', 0, 1],
      ['planning', 1, 2],
      ['plan-review', 2, 3],
      ['plan-rework', 5, null],
    ]);
    expectWellFormed(segments, { closed: false, gapsAt: [at(5)] });
  });

  it('中止を挟んだ同じ種類の区間はつながない', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [entry(2, 'plan', '提出'), entry(3, 'plan', '中止'), entry(5, 'plan', '再提出')],
      })
    );

    expect(shape(segments).slice(2)).toEqual([
      ['plan-review', 2, 3],
      ['plan-review', 5, null],
    ]);
  });

  it('中止の後に Draft へ戻す痕跡が来ても区間を開かない', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [entry(2, 'plan', '提出'), entry(3, 'plan', '承認'), entry(7, 'plan', '中止')],
        readyAt: at(6),
        convertedToDraftAt: at(8),
      })
    );

    expect(shape(segments).slice(-2)).toEqual([
      ['implementing', 3, 6],
      ['pr-review', 6, 7],
    ]);
    expectWellFormed(segments, { closed: true });
  });

  it('中止の後に Ready にする痕跡が来ても区間を開かない', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [entry(2, 'plan', '提出'), entry(3, 'plan', '承認'), entry(4, 'plan', '中止')],
        readyAt: at(5),
      })
    );

    expect(shape(segments).slice(-1)).toEqual([['implementing', 3, 4]]);
    expectWellFormed(segments, { closed: true });
  });

  it('中止の後にエントリが続けば、PR の痕跡ではなくエントリから区間を始め直す', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [
          entry(2, 'plan', '提出'),
          entry(3, 'plan', '承認'),
          entry(5, 'plan', '中止'),
          entry(7, 'plan', '否決'),
        ],
        readyAt: at(6),
      })
    );

    expect(shape(segments).slice(-2)).toEqual([
      ['implementing', 3, 5],
      ['plan-rework', 7, null],
    ]);
    expectWellFormed(segments, { closed: false, gapsAt: [at(7)] });
  });

  it('Draft に戻された: pr-review が閉じ、draft-returned（人）が開いている', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [entry(2, 'plan', '提出'), entry(3, 'plan', '承認')],
        readyAt: at(6),
        convertedToDraftAt: at(7),
      })
    );

    expect(shape(segments).slice(3)).toEqual([
      ['implementing', 3, 6],
      ['pr-review', 6, 7],
      ['draft-returned', 7, null],
    ]);
    expect(segments.at(-1)?.owner).toBe('human');
    expectWellFormed(segments, { closed: false });
  });

  it('Draft に戻された後の計画から立て直させる: draft-returned を閉じて plan-rework を始める', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [
          entry(2, 'plan', '提出'),
          entry(3, 'plan', '承認'),
          entry(8, 'plan', '否決'),
          entry(9, 'plan', '再提出'),
          entry(10, 'plan', '承認'),
        ],
        readyAt: at(6),
        convertedToDraftAt: at(7),
      })
    );

    expect(shape(segments).slice(4)).toEqual([
      ['pr-review', 6, 7],
      ['draft-returned', 7, 8],
      ['plan-rework', 8, 9],
      ['plan-review', 9, 10],
      ['implementing', 10, null],
    ]);
    expectWellFormed(segments, { closed: false });
  });
});

// ============================================================
// 表に収まらない痕跡
// ============================================================

describe('resolveTimeline: 表に収まらない痕跡', () => {
  it('plan を飛ばす: 着手から planning が始まり、plan 提出から implementing が始まる', () => {
    const segments = resolveTimeline(
      makeTraces({ startedAt: at(1), skipGates: ['plan'], entries: [entry(2, 'plan', '提出')] })
    );

    expect(shape(segments)).toEqual([
      ['idea', 0, 1],
      ['planning', 1, 2],
      ['implementing', 2, null],
    ]);
    expectWellFormed(segments, { closed: false });
  });

  it('plan を飛ばす: 否決の後の plan 再提出から implementing に戻る', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        skipGates: ['plan'],
        entries: [entry(2, 'plan', '提出'), entry(3, 'plan', '否決'), entry(4, 'plan', '再提出')],
      })
    );

    expect(shape(segments)).toEqual([
      ['idea', 0, 1],
      ['planning', 1, 2],
      ['implementing', 2, 3],
      ['plan-rework', 3, 4],
      ['implementing', 4, null],
    ]);
    expectWellFormed(segments, { closed: false });
  });

  it('Ready: implementing が Ready で閉じて pr-review になる', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [entry(2, 'plan', '提出'), entry(3, 'plan', '承認')],
        readyAt: at(4),
        mergedAt: at(5),
      })
    );

    expect(shape(segments).slice(3)).toEqual([
      ['implementing', 3, 4],
      ['pr-review', 4, 5],
    ]);
    expectWellFormed(segments, { closed: true });
  });

  it('GitHub につながっていない: 最後のエントリからの区間が開いたまま残る', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [entry(2, 'plan', '提出'), entry(3, 'plan', '承認')],
      })
    );

    expect(shape(segments).at(-1)).toEqual(['implementing', 3, null]);
    expectWellFormed(segments, { closed: false });
  });

  it('startedAt が欠けた: idea が最初のエントリまで続き、planning が無い', () => {
    const segments = resolveTimeline(
      makeTraces({
        entries: [entry(3, 'plan', '提出'), entry(4, 'plan', '承認')],
      })
    );

    expect(shape(segments)).toEqual([
      ['idea', 0, 3],
      ['plan-review', 3, 4],
      ['implementing', 4, null],
    ]);
    expectWellFormed(segments, { closed: false });
  });

  it('startedAt が最初のエントリより遅い: 着手を無いものとして扱う', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(5),
        entries: [entry(3, 'plan', '提出'), entry(4, 'plan', '承認')],
      })
    );

    expect(shape(segments)).toEqual([
      ['idea', 0, 3],
      ['plan-review', 3, 4],
      ['implementing', 4, null],
    ]);
    expectWellFormed(segments, { closed: false });
  });

  it('エントリが書かれた順と時刻の順が違っても、時刻の順に読む', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [entry(3, 'plan', '承認'), entry(2, 'plan', '提出')],
      })
    );

    expect(shape(segments)).toEqual([
      ['idea', 0, 1],
      ['planning', 1, 2],
      ['plan-review', 2, 3],
      ['implementing', 3, null],
    ]);
    expectWellFormed(segments, { closed: false });
  });

  it('時刻の表記の違い（ミリ秒の有無）があっても同じ時刻として扱う', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: '2026-10-01T01:00:00.000Z',
        entries: [{ at: '2026-10-01T02:00:00.000Z', gate: 'plan', kind: '提出', reason: '' }],
        readyAt: '2026-10-01T02:00:00Z',
        mergedAt: '2026-10-01T03:00:00Z',
      })
    );

    expect(shape(segments)).toEqual([
      ['idea', 0, 1],
      ['planning', 1, 2],
      ['pr-review', 2, 3],
    ]);
    expectWellFormed(segments, { closed: true });
  });
});

// ============================================================
// 同じ時刻の痕跡・区間のつなぎ
// ============================================================

describe('resolveTimeline: 同じ時刻の痕跡', () => {
  it('起票と同時の着手: 長さ 0 の idea を落とす', () => {
    const segments = resolveTimeline(makeTraces({ startedAt: at(0) }));

    expect(shape(segments)).toEqual([['planning', 0, null]]);
    expectWellFormed(segments, { closed: false });
  });

  it('着手と同時の plan 提出: 着手を先に読み、長さ 0 の planning を落とす', () => {
    const segments = resolveTimeline(
      makeTraces({ startedAt: at(1), entries: [entry(1, 'plan', '提出')] })
    );

    expect(shape(segments)).toEqual([
      ['idea', 0, 1],
      ['plan-review', 1, null],
    ]);
    expectWellFormed(segments, { closed: false });
  });

  it('同じ時刻のエントリは書かれた順に読む', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [entry(2, 'plan', '提出'), entry(3, 'plan', '否決'), entry(3, 'plan', '保留')],
      })
    );

    expect(shape(segments).slice(2)).toEqual([
      ['plan-review', 2, 3],
      ['plan-held', 3, null],
    ]);
    expectWellFormed(segments, { closed: false });
  });

  it('長さ 0 の区間を落として同じ種類が隣り合ったら、1 つにつなぐ', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [entry(2, 'plan', '提出'), entry(3, 'plan', '否決'), entry(3, 'plan', '再提出')],
      })
    );

    expect(shape(segments).slice(2)).toEqual([['plan-review', 2, null]]);
    expectWellFormed(segments, { closed: false });
  });

  it('否決を挟まない再提出: plan-review は 1 区間につながる', () => {
    const segments = resolveTimeline(
      makeTraces({
        startedAt: at(1),
        entries: [entry(2, 'plan', '提出'), entry(3, 'plan', '再提出'), entry(4, 'plan', '承認')],
      })
    );

    expect(shape(segments).slice(2)).toEqual([
      ['plan-review', 2, 4],
      ['implementing', 4, null],
    ]);
    expectWellFormed(segments, { closed: false });
  });
});
