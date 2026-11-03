import { describe, it, expect } from 'vitest';
import {
  TIMELINE_KIND_LABELS,
  estimateTextWidth,
  formatDuration,
  renderDailyMergesChart,
  renderStageChart,
} from '../status-charts.js';
import type { StageDuration } from '../../../shared/board-metrics.js';

const HOUR = 60 * 60 * 1000;

const STAGES: readonly StageDuration[] = [
  { kind: 'planning', owner: 'ai', medianMs: 2 * HOUR, cardCount: 3 },
  { kind: 'plan-review', owner: 'human', medianMs: 10 * HOUR, cardCount: 3 },
  { kind: 'implementing', owner: 'ai', medianMs: 5 * HOUR, cardCount: 2 },
];

const DAY = 24 * HOUR;

/** `kind` の工程の棒の幅 */
function barWidth(svg: string, kind: string): number {
  const match = svg.match(new RegExp(`data-kind="${kind}">[\\s\\S]*?<rect [^>]*width="(\\d+)"`));
  return Number(match?.[1]);
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

describe('renderStageChart', () => {
  it('工程ごとに 1 本の棒と、工程の名前・時間のラベルを出す', () => {
    const svg = renderStageChart(STAGES, 'plan-review');

    expect(svg.startsWith('<svg class="chart"')).toBe(true);
    expect(count(svg, /<g class="row"/g)).toBe(3);
    expect(svg).toContain('>計画提案中</text>');
    expect(svg).toContain('>計画レビュー</text>');
    expect(svg).toContain('2時間（AI・3 枚）');
    expect(svg).toContain('10時間（人・3 枚）');
  });

  it('棒の色は人 / AI の class で分け、色を SVG に書かない', () => {
    const svg = renderStageChart(STAGES, 'plan-review');

    expect(svg).toMatch(/data-kind="plan-review">[\s\S]*?class="bar bar-human bar-bottleneck"/);
    expect(svg).toMatch(/data-kind="planning">[\s\S]*?class="bar bar-ai"/);
    expect(svg).not.toMatch(/fill="#|#[0-9a-f]{6}/i);
  });

  it('ボトルネックの工程にだけ印を付ける', () => {
    const svg = renderStageChart(STAGES, 'plan-review');

    expect(count(svg, /ボトルネック</g)).toBe(1);
    expect(svg).toContain('10時間（人・3 枚） ボトルネック');
    expect(count(svg, /bar-bottleneck/g)).toBe(1);
    expect(svg).toContain(
      'aria-label="工程ごとの滞在時間（マージ済みのカード 1 枚あたりの中央値）。ボトルネックは計画レビュー"'
    );
  });

  it('いちばん長い棒を棒の幅いっぱいにし、ほかは長さに比例させる', () => {
    const svg = renderStageChart(STAGES, 'plan-review');

    expect(barWidth(svg, 'plan-review')).toBe(276);
    expect(barWidth(svg, 'implementing')).toBe(138);
  });

  it('いちばん長い棒の後ろのボトルネックのラベルが、viewBox の幅に収まる', () => {
    const long: readonly StageDuration[] = [
      { kind: 'implementing', owner: 'ai', medianMs: 2 * HOUR, cardCount: 12 },
      { kind: 'draft-returned', owner: 'ai', medianMs: 123 * DAY + 23 * HOUR, cardCount: 120 },
    ];
    for (const stages of [STAGES, long]) {
      const svg = renderStageChart(stages, stages[1]?.kind ?? null);
      const viewBoxWidth = Number(svg.match(/viewBox="0 0 (\d+) /)?.[1]);
      const value = svg.match(/<text class="value value-bottleneck" x="(\d+)"[^>]*>([^<]*)</);
      const x = Number(value?.[1]);
      const text = value?.[2] ?? '';

      expect(text).toContain('ボトルネック');
      expect(viewBoxWidth).toBe(640);
      expect(x + estimateTextWidth(text)).toBeLessThanOrEqual(viewBoxWidth);
    }
  });

  it('文字の幅の見積もりは、全角を 1em、半角を 0.6em と数える', () => {
    expect(estimateTextWidth('ボトル')).toBe(36);
    expect(estimateTextWidth('12 枚')).toBeCloseTo(12 * (0.6 * 3 + 1));
  });

  it('工程が無ければ「まだありません」', () => {
    expect(renderStageChart([], null)).toBe('<p class="empty">まだありません</p>');
  });
});

describe('renderDailyMergesChart', () => {
  it('日ごとに 1 本の棒と、日付・件数のラベルを出す。0 件の日は件数を出さない', () => {
    const svg = renderDailyMergesChart([
      { date: '2026-11-01', count: 2 },
      { date: '2026-11-02', count: 0 },
      { date: '2026-11-03', count: 1 },
    ]);

    expect(count(svg, /<g class="day"/g)).toBe(3);
    expect(svg).toContain('>11-01</text>');
    expect(svg).toContain('>11-03</text>');
    expect(svg).toContain('<title>2026-11-02: 0 件</title>');
    expect(count(svg, /class="value"/g)).toBe(2);
    expect(svg).toContain('計 3 件');
  });

  it('日が多ければ日付のラベルを間引き、最後の日には必ず付ける', () => {
    const days = Array.from({ length: 30 }, (_, index) => ({
      date: `2026-10-${String(index + 1).padStart(2, '0')}`,
      count: 1,
    }));
    const svg = renderDailyMergesChart(days);

    expect(count(svg, /<g class="day"/g)).toBe(30);
    expect(count(svg, /class="label"/g)).toBeLessThan(30);
    expect(svg).toContain('>10-30</text>');
  });

  it('日が無ければ「まだありません」', () => {
    expect(renderDailyMergesChart([])).toBe('<p class="empty">まだありません</p>');
  });

  it('日付の文字はエスケープする', () => {
    const svg = renderDailyMergesChart([{ date: '2026-<b>"x', count: 1 }]);

    expect(svg).not.toContain('<b>');
    expect(svg).toContain('&lt;b&gt;&quot;x');
  });
});

describe('renderStageChart のボトルネックが無いとき', () => {
  it('工程の名前は TIMELINE_KIND_LABELS から引き、印を付けない', () => {
    const svg = renderStageChart(
      [{ kind: 'readying', owner: 'ai', medianMs: HOUR, cardCount: 1 }],
      null
    );

    expect(svg).toContain(`>${TIMELINE_KIND_LABELS.readying}</text>`);
    expect(svg).not.toContain('ボトルネック');
  });
});

describe('formatDuration', () => {
  it('上の 2 つの単位だけを出す', () => {
    expect(formatDuration(30 * 1000)).toBe('1分未満');
    expect(formatDuration(12 * 60 * 1000)).toBe('12分');
    expect(formatDuration(5 * HOUR + 12 * 60 * 1000)).toBe('5時間 12分');
    expect(formatDuration(3 * HOUR)).toBe('3時間');
    expect(formatDuration(3 * 24 * HOUR + 4 * HOUR + 5 * 60 * 1000)).toBe('3日 4時間');
    expect(formatDuration(2 * 24 * HOUR)).toBe('2日');
  });
});
