import { describe, it, expect } from 'vitest';
import {
  computeBoardMetrics,
  median,
  segmentMs,
  utcDate,
  type MetricsCard,
} from '../board-metrics.js';
import { TIMELINE_OWNERS, type TimelineKind, type TimelineSegment } from '../timeline.js';
import type { LoopStep } from '../loop-step.js';

const GENERATED_AT = '2026-11-03T00:00:00.000Z';
const HOUR = 60 * 60 * 1000;

function card(overrides: Partial<MetricsCard> = {}): MetricsCard {
  return {
    stage: 'idea',
    aborted: false,
    startedAt: null,
    mrState: null,
    plan: null,
    reviews: [],
    timeline: [],
    loopSteps: [],
    ...overrides,
  };
}

/** `start` から `hours` 時間の区間。`hours` が null なら今いる区間 */
function segment(kind: TimelineKind, start: string, hours: number | null): TimelineSegment {
  const end = hours === null ? null : new Date(Date.parse(start) + hours * HOUR).toISOString();
  return { kind, owner: TIMELINE_OWNERS[kind], start, end };
}

function merged(mergedAt: string, overrides: Partial<MetricsCard> = {}): MetricsCard {
  return card({ stage: 'merged', mrState: { mergedAt }, ...overrides });
}

type StepInput = MetricsCard['loopSteps'][number];

function step(overrides: Partial<Pick<LoopStep, keyof StepInput>> = {}): StepInput {
  return {
    action: 'plan',
    step: null,
    result: 'advanced',
    tokens: 1000,
    durationMs: 60_000,
    ...overrides,
  };
}

describe('computeBoardMetrics', () => {
  it('マージ済みが 0 枚なら、数字は null、グラフの元は空', () => {
    const metrics = computeBoardMetrics([card(), card({ stage: 'planning' })]);

    expect(metrics.summary).toEqual({
      mergedCount: 0,
      leadTimeMedianMs: null,
      leadTimeMaxMs: null,
      humanShareMedian: null,
      rejectedCardCount: 0,
      rejectionCount: 0,
      ideaCount: 1,
    });
    expect(metrics.stages).toEqual([]);
    expect(metrics.bottleneck).toBeNull();
    expect(metrics.dailyMerges).toEqual([]);
    expect(metrics.loopActions).toEqual([]);
    expect(metrics.loopResults).toEqual([]);
  });

  it('着手からマージまでの中央値と最長を出す。どちらかの時刻が無いカードは数えない', () => {
    const metrics = computeBoardMetrics([
      merged('2026-11-01T02:00:00.000Z', { startedAt: '2026-11-01T00:00:00.000Z' }),
      merged('2026-11-01T06:00:00.000Z', { startedAt: '2026-11-01T00:00:00.000Z' }),
      merged('2026-11-01T06:00:00.000Z', { startedAt: null }),
    ]);

    expect(metrics.summary.mergedCount).toBe(3);
    expect(metrics.summary.leadTimeMedianMs).toBe(4 * HOUR);
    expect(metrics.summary.leadTimeMaxMs).toBe(6 * HOUR);
  });

  it('マージ済みのカードの閉じていない区間（end が null）は、マージの時刻で閉じる', () => {
    const metrics = computeBoardMetrics([
      merged('2026-11-02T23:00:00.000Z', {
        timeline: [
          segment('implementing', '2026-11-02T20:00:00.000Z', 1),
          segment('pr-review', '2026-11-02T21:00:00.000Z', null),
        ],
      }),
    ]);

    expect(metrics.stages).toEqual([
      { kind: 'implementing', owner: 'ai', medianMs: HOUR, cardCount: 1 },
      { kind: 'pr-review', owner: 'human', medianMs: 2 * HOUR, cardCount: 1 },
    ]);
    // 人 2 時間 ÷ 全 3 時間
    expect(metrics.summary.humanShareMedian).toBeCloseTo(2 / 3);
  });

  it('マージの時刻が無いマージ済みのカードは、計画の最終更新で区間を閉じる', () => {
    const metrics = computeBoardMetrics([
      card({
        stage: 'merged',
        mrState: null,
        plan: { updatedAt: '2026-11-02T22:00:00.000Z' },
        timeline: [segment('pr-review', '2026-11-02T21:00:00.000Z', null)],
      }),
      card({
        stage: 'merged',
        mrState: { mergedAt: null },
        plan: { updatedAt: '2026-11-02T23:00:00.000Z' },
        timeline: [segment('pr-review', '2026-11-02T21:00:00.000Z', null)],
      }),
    ]);

    // 1 時間と 2 時間の中央値。generatedAt には左右されない
    expect(metrics.stages).toEqual([
      { kind: 'pr-review', owner: 'human', medianMs: 1.5 * HOUR, cardCount: 2 },
    ]);
    expect(metrics.summary.humanShareMedian).toBe(1);
  });

  it('マージの時刻も計画の最終更新も無いマージ済みのカードは、工程と人の番の割合から除く', () => {
    const metrics = computeBoardMetrics([
      card({
        stage: 'merged',
        mrState: null,
        plan: null,
        timeline: [segment('pr-review', '2026-11-02T21:00:00.000Z', null)],
      }),
    ]);

    expect(metrics.summary.mergedCount).toBe(1);
    expect(metrics.stages).toEqual([]);
    expect(metrics.bottleneck).toBeNull();
    expect(metrics.summary.humanShareMedian).toBeNull();
  });

  it('同じ種類の区間が 2 度ある（差し戻し）カードは、足してから中央値を取る', () => {
    const metrics = computeBoardMetrics([
      merged('2026-11-02T00:00:00.000Z', {
        timeline: [
          segment('implementing', '2026-11-01T00:00:00.000Z', 1),
          segment('pr-review', '2026-11-01T01:00:00.000Z', 1),
          segment('implementing', '2026-11-01T02:00:00.000Z', 3),
        ],
      }),
      merged('2026-11-02T00:00:00.000Z', {
        timeline: [segment('implementing', '2026-11-01T00:00:00.000Z', 2)],
      }),
    ]);

    const implementing = metrics.stages.find((stage) => stage.kind === 'implementing');
    // 1 枚目は 1 + 3 = 4 時間、2 枚目は 2 時間。中央値は 3 時間
    expect(implementing).toEqual({
      kind: 'implementing',
      owner: 'ai',
      medianMs: 3 * HOUR,
      cardCount: 2,
    });
    // その種類の区間が無いカードは数えない
    expect(metrics.stages.find((stage) => stage.kind === 'pr-review')?.cardCount).toBe(1);
  });

  it('工程は工程の順に並べ、いちばん長い中央値の工程をボトルネックにする', () => {
    const metrics = computeBoardMetrics([
      merged('2026-11-02T00:00:00.000Z', {
        timeline: [
          segment('planning', '2026-11-01T00:00:00.000Z', 1),
          segment('plan-review', '2026-11-01T01:00:00.000Z', 5),
          segment('implementing', '2026-11-01T06:00:00.000Z', 2),
        ],
      }),
    ]);

    expect(metrics.stages.map((stage) => stage.kind)).toEqual([
      'planning',
      'plan-review',
      'implementing',
    ]);
    expect(metrics.bottleneck).toBe('plan-review');
  });

  it('ボトルネックの同点は工程の順で前のもの', () => {
    const metrics = computeBoardMetrics([
      merged('2026-11-02T00:00:00.000Z', {
        timeline: [
          segment('pr-review', '2026-11-01T00:00:00.000Z', 4),
          segment('planning', '2026-11-01T04:00:00.000Z', 4),
        ],
      }),
    ]);

    expect(metrics.bottleneck).toBe('planning');
  });

  it('人の番の割合は、マージ済みのカードごとの割合の中央値', () => {
    const metrics = computeBoardMetrics([
      // 人 1 / 全体 4
      merged('2026-11-02T00:00:00.000Z', {
        timeline: [
          segment('implementing', '2026-11-01T00:00:00.000Z', 3),
          segment('pr-review', '2026-11-01T03:00:00.000Z', 1),
        ],
      }),
      // 人 3 / 全体 4
      merged('2026-11-02T00:00:00.000Z', {
        timeline: [
          segment('implementing', '2026-11-01T00:00:00.000Z', 1),
          segment('pr-review', '2026-11-01T01:00:00.000Z', 3),
        ],
      }),
      // 区間の無いカードは数えない
      merged('2026-11-02T00:00:00.000Z'),
    ]);

    expect(metrics.summary.humanShareMedian).toBe(0.5);
  });

  it('中止したカードはどの集計にも入れない', () => {
    const metrics = computeBoardMetrics([
      merged('2026-11-02T00:00:00.000Z', {
        aborted: true,
        startedAt: '2026-11-01T00:00:00.000Z',
        reviews: [{ kind: '否決' }],
        timeline: [segment('planning', '2026-11-01T00:00:00.000Z', 1)],
        loopSteps: [step()],
      }),
      card({ aborted: true }),
    ]);

    expect(metrics.summary.mergedCount).toBe(0);
    expect(metrics.summary.ideaCount).toBe(0);
    expect(metrics.summary.rejectionCount).toBe(0);
    expect(metrics.stages).toEqual([]);
    expect(metrics.dailyMerges).toEqual([]);
    expect(metrics.loopActions).toEqual([]);
  });

  it('否決は plan と verify の両方を数え、否決のあるカードの枚数と延べ回数を出す', () => {
    const metrics = computeBoardMetrics([
      card({
        stage: 'impling',
        reviews: [{ kind: '提出' }, { kind: '否決' }, { kind: '再提出' }, { kind: '承認' }],
      }),
      merged('2026-11-02T00:00:00.000Z', {
        reviews: [{ kind: '否決' }, { kind: '否決' }],
      }),
      card({ stage: 'planning', reviews: [{ kind: '提出' }] }),
    ]);

    expect(metrics.summary.rejectedCardCount).toBe(2);
    expect(metrics.summary.rejectionCount).toBe(3);
  });

  it('日ごとのマージ数は UTC の日付で数え、間の日を 0 で埋める', () => {
    const metrics = computeBoardMetrics([
      // UTC では 10-31 の終わり（日本時間では 11-01）
      merged('2026-10-31T23:59:59.000Z'),
      merged('2026-11-01T00:00:00.000Z'),
      merged('2026-11-01T12:00:00.000Z'),
      merged('2026-11-03T00:00:00.000Z'),
    ]);

    expect(metrics.dailyMerges).toEqual([
      { date: '2026-10-31', count: 1 },
      { date: '2026-11-01', count: 2 },
      { date: '2026-11-02', count: 0 },
      { date: '2026-11-03', count: 1 },
    ]);
  });

  it('ループの手は、durationMs と tokens が null の記録を平均から除き、除いた件数を返す', () => {
    const metrics = computeBoardMetrics([
      card({
        stage: 'planning',
        loopSteps: [
          step({ durationMs: 60_000, tokens: 1000 }),
          step({ durationMs: 120_000, tokens: null }),
          step({ durationMs: null, tokens: null }),
        ],
      }),
    ]);

    expect(metrics.loopActions).toEqual([
      {
        action: 'plan',
        step: null,
        count: 3,
        avgDurationMs: 90_000,
        missingDuration: 1,
        avgTokens: 1000,
        missingTokens: 2,
      },
    ]);
  });

  it('implement の手は段ごとに分け、段の分からないものを最後に置く', () => {
    const metrics = computeBoardMetrics([
      card({
        stage: 'impling',
        loopSteps: [
          step({ action: 'implement', step: null }),
          step({ action: 'implement', step: 'close' }),
          step({ action: 'implement', step: 'task' }),
          step({ action: 'implement', step: 'task' }),
          step({ action: 'ready' }),
          step({ action: 'plan' }),
        ],
      }),
    ]);

    expect(
      metrics.loopActions.map((entry) => [entry.action, entry.step, entry.count] as const)
    ).toEqual([
      ['plan', null, 1],
      ['implement', 'task', 2],
      ['implement', 'close', 1],
      ['implement', null, 1],
      ['ready', null, 1],
    ]);
  });

  it('手の結果を結果ごとに数え、終わっていない記録は running にする', () => {
    const metrics = computeBoardMetrics([
      card({
        stage: 'impling',
        loopSteps: [
          step({ result: 'advanced' }),
          step({ result: 'advanced' }),
          step({ result: 'stopped' }),
          step({ result: null }),
        ],
      }),
    ]);

    expect(metrics.loopResults).toEqual([
      { result: 'advanced', count: 2 },
      { result: 'stopped', count: 1 },
      { result: 'running', count: 1 },
    ]);
  });
});

describe('median', () => {
  it('奇数個は真ん中、偶数個は真ん中の 2 つの平均、空は null', () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('segmentMs', () => {
  it('end が null なら generatedAt までを数え、読めない・逆向きの区間は 0', () => {
    expect(segmentMs({ start: '2026-11-02T23:00:00.000Z', end: null }, GENERATED_AT)).toBe(HOUR);
    expect(segmentMs({ start: 'x', end: null }, GENERATED_AT)).toBe(0);
    expect(
      segmentMs(
        { start: '2026-11-02T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
        GENERATED_AT
      )
    ).toBe(0);
  });
});

describe('utcDate', () => {
  it('UTC の日付を返し、読めなければ null', () => {
    expect(utcDate('2026-11-01T08:30:00+09:00')).toBe('2026-10-31');
    expect(utcDate('x')).toBeNull();
    expect(utcDate(null)).toBeNull();
  });
});
