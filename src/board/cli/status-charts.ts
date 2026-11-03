import type { DailyMerges, StageDuration } from '../../shared/board-metrics.js';
import type { TimelineKind, TimelineOwner } from '../../shared/timeline.js';
import { escapeHtml } from './html-text.js';

// ============================================================
// status --html のグラフ — インラインの SVG の文字列を作る純関数
// ============================================================

/**
 * グラフは外部のスクリプトを読まず、CLI がインラインの SVG として描く。
 * 同じデータからは同じ文字列ができる（今の時刻も乱数も読まない）。
 *
 * 色は CSS の変数（`status-html.ts` の `:root` のトークン）を class で指し、SVG の中に色を書かない。
 * 値は棒の横に文字でも出し、色だけに頼らない。文字はすべて `escapeHtml` を通す。
 */

/** 区間の種類の日本語の名前 */
export const TIMELINE_KIND_LABELS: Record<TimelineKind, string> = {
  idea: 'アイデア',
  planning: '計画提案中',
  'plan-review': '計画レビュー',
  'plan-rework': '計画の直し',
  'plan-held': '計画の保留',
  implementing: '実装中',
  'pr-review': 'PR中',
  'draft-returned': 'Draft に戻された後',
};

const OWNER_LABELS: Record<TimelineOwner, string> = { human: '人', ai: 'AI' };

const EMPTY = '<p class="empty">まだありません</p>';

// ============================================================
// 工程ごとの滞在時間（横棒）
// ============================================================

const STAGE_WIDTH = 640;
const STAGE_LABEL_WIDTH = 150;
/** 値のラベルの欄の最小の幅。実際の幅は、いちばん長いラベルが viewBox に収まるように広げる */
const STAGE_VALUE_MIN_WIDTH = 170;
/** 棒の終わりから値のラベルの書き出しまで */
const STAGE_VALUE_GAP = 6;
/** 値のラベルの右の余白（文字の幅の見積もりの誤差と太字の分） */
const STAGE_VALUE_PADDING = 16;
/** `.chart text` の文字の大きさ（`status-html.ts` の CSS と合わせる） */
const CHART_FONT_SIZE = 12;
const STAGE_ROW = 28;
const STAGE_BAR = 18;
const LEGEND_HEIGHT = 26;

/**
 * 工程ごとの滞在時間を横棒にする。棒は人 / AI で色を分け、`bottleneck` の工程には印を付ける。
 * 工程が無ければ「まだありません」
 */
export function renderStageChart(
  stages: readonly StageDuration[],
  bottleneck: TimelineKind | null
): string {
  if (stages.length === 0) return EMPTY;

  const max = Math.max(...stages.map((stage) => stage.medianMs));
  const values = stages.map((stage) => stageValueLabel(stage, stage.kind === bottleneck));
  // いちばん長い棒（棒の領域いっぱい）の後ろにも、いちばん長いラベルが収まる幅を値の欄に取る
  const valueWidth = Math.max(
    STAGE_VALUE_MIN_WIDTH,
    Math.ceil(STAGE_VALUE_GAP + Math.max(...values.map(estimateTextWidth)) + STAGE_VALUE_PADDING)
  );
  const barArea = STAGE_WIDTH - STAGE_LABEL_WIDTH - valueWidth;
  const height = LEGEND_HEIGHT + stages.length * STAGE_ROW;

  const rows = stages.map((stage, index) => {
    const y = LEGEND_HEIGHT + index * STAGE_ROW;
    const width = max === 0 ? 0 : Math.max(2, Math.round((stage.medianMs / max) * barArea));
    const isBottleneck = stage.kind === bottleneck;
    const value = values[index] ?? '';
    const barClass = `bar bar-${stage.owner}${isBottleneck ? ' bar-bottleneck' : ''}`;
    const textY = y + STAGE_BAR / 2 + 5;

    return `<g class="row" data-kind="${escapeHtml(stage.kind)}">
<text class="label" x="${STAGE_LABEL_WIDTH - 8}" y="${textY}" text-anchor="end">${escapeHtml(TIMELINE_KIND_LABELS[stage.kind])}</text>
<rect class="${barClass}" x="${STAGE_LABEL_WIDTH}" y="${y}" width="${width}" height="${STAGE_BAR}" rx="3"/>
<text class="value${isBottleneck ? ' value-bottleneck' : ''}" x="${STAGE_LABEL_WIDTH + width + STAGE_VALUE_GAP}" y="${textY}">${escapeHtml(value)}</text>
</g>`;
  });

  const label = `工程ごとの滞在時間（マージ済みのカード 1 枚あたりの中央値）${
    bottleneck === null ? '' : `。ボトルネックは${TIMELINE_KIND_LABELS[bottleneck]}`
  }`;

  return `<svg class="chart" viewBox="0 0 ${STAGE_WIDTH} ${height}" role="img" aria-label="${escapeHtml(label)}">
${renderLegend()}
${rows.join('\n')}
</svg>`;
}

/** 棒の横に出す値のラベル。ボトルネックの工程には印を添える */
function stageValueLabel(stage: StageDuration, isBottleneck: boolean): string {
  const value = `${formatDuration(stage.medianMs)}（${OWNER_LABELS[stage.owner]}・${stage.cardCount} 枚）`;
  return isBottleneck ? `${value} ボトルネック` : value;
}

/**
 * グラフの文字の幅の見積もり（viewBox の単位）。全角は 1 文字 1em、半角は 0.6em と数える。
 * SVG の文字は折り返さず、viewBox の外は隠れるので、ラベルが収まるかをこれで決める
 */
export function estimateTextWidth(text: string): number {
  let ems = 0;
  for (const char of text) {
    ems += (char.codePointAt(0) ?? 0) > 0xff ? 1 : 0.6;
  }
  return ems * CHART_FONT_SIZE;
}

function renderLegend(): string {
  return `<g class="legend">
<rect class="bar bar-human" x="0" y="4" width="12" height="12" rx="2"/>
<text class="label" x="18" y="15">人の番</text>
<rect class="bar bar-ai" x="80" y="4" width="12" height="12" rx="2"/>
<text class="label" x="98" y="15">AI の番</text>
</g>`;
}

// ============================================================
// 日ごとのマージ数（縦棒）
// ============================================================

const DAILY_HEIGHT = 160;
const DAILY_TOP = 18;
const DAILY_BOTTOM = 22;
const DAILY_SLOT = 28;
const DAILY_MIN_WIDTH = 280;
/** 日付のラベルを全部の棒に付ける上限。超えたら間引く */
const DAILY_LABEL_EVERY_LIMIT = 14;

/** 日ごとのマージ数を縦棒にする。日が無ければ「まだありません」 */
export function renderDailyMergesChart(days: readonly DailyMerges[]): string {
  if (days.length === 0) return EMPTY;

  const max = Math.max(1, ...days.map((day) => day.count));
  const width = Math.max(DAILY_MIN_WIDTH, days.length * DAILY_SLOT);
  const slot = width / days.length;
  const plot = DAILY_HEIGHT - DAILY_TOP - DAILY_BOTTOM;
  const labelStep = Math.ceil(days.length / DAILY_LABEL_EVERY_LIMIT);

  const bars = days.map((day, index) => {
    const barHeight = Math.round((day.count / max) * plot);
    const x = Math.round(index * slot + slot * 0.2);
    const barWidth = Math.max(2, Math.round(slot * 0.6));
    const y = DAILY_TOP + plot - barHeight;
    const center = Math.round(index * slot + slot / 2);
    const showDate = index % labelStep === 0 || index === days.length - 1;
    const date = showDate
      ? `\n<text class="label" x="${center}" y="${DAILY_HEIGHT - 6}" text-anchor="middle">${escapeHtml(day.date.slice(5))}</text>`
      : '';
    const count =
      day.count === 0
        ? ''
        : `\n<text class="value" x="${center}" y="${y - 4}" text-anchor="middle">${day.count}</text>`;

    return `<g class="day" data-date="${escapeHtml(day.date)}">
<title>${escapeHtml(`${day.date}: ${day.count} 件`)}</title>
<rect class="bar bar-merged" x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="2"/>${count}${date}
</g>`;
  });

  const total = days.reduce((sum, day) => sum + day.count, 0);
  const label = `日ごとのマージ数（${days[0]?.date} から ${days[days.length - 1]?.date}、計 ${total} 件）`;

  return `<svg class="chart" viewBox="0 0 ${Math.round(width)} ${DAILY_HEIGHT}" role="img" aria-label="${escapeHtml(label)}">
<line class="axis" x1="0" y1="${DAILY_TOP + plot}" x2="${Math.round(width)}" y2="${DAILY_TOP + plot}"/>
${bars.join('\n')}
</svg>`;
}

// ============================================================
// 時間の書き方
// ============================================================

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `3日 4時間` / `5時間 12分` / `12分` / `1分未満`。上の 2 つの単位だけを出す */
export function formatDuration(ms: number): string {
  if (ms < MINUTE) return '1分未満';

  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);

  if (days > 0) return hours === 0 ? `${days}日` : `${days}日 ${hours}時間`;
  if (hours > 0) return minutes === 0 ? `${hours}時間` : `${hours}時間 ${minutes}分`;
  return `${minutes}分`;
}
