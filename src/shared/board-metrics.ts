import {
  LOOP_ACTIONS,
  LOOP_IMPL_STEPS,
  LOOP_RESULTS,
  type LoopAction,
  type LoopImplStep,
  type LoopResult,
  type LoopStep,
} from './loop-step.js';
import type { Stage } from './schemas/common.js';
import {
  TIMELINE_KINDS,
  TIMELINE_OWNERS,
  type TimelineKind,
  type TimelineOwner,
  type TimelineSegment,
} from './timeline.js';

// ============================================================
// ボード全体の集計 — ダッシュボードの数字とグラフの元
// ============================================================

/**
 * 集計に使うカードの形。ボードのカード（`BoardCard`）から要る項目だけを受け取る。
 *
 * `src/shared/` はサーバと web の両方から読むので、サーバの型は引かずに使う形だけを書く。
 * `reviews[].kind` は `ReviewKind`（`src/cards/models/review.ts`）の値で、`否決` だけを数える。
 */
export interface MetricsCard {
  readonly stage: Stage;
  readonly aborted: boolean;
  readonly startedAt: string | null;
  readonly mrState: { readonly mergedAt: string | null } | null;
  /** 計画ファイルの最終更新。マージの時刻が読めないマージ済みのカードで、その代わりに使う */
  readonly plan: { readonly updatedAt: string } | null;
  readonly reviews: readonly { readonly kind: string }[];
  readonly timeline: readonly TimelineSegment[];
  readonly loopSteps: readonly Pick<
    LoopStep,
    'action' | 'step' | 'result' | 'tokens' | 'durationMs'
  >[];
}

/** 主な数字。時間はミリ秒、割合は 0〜1。数えるカードが無ければ null */
export interface MetricsSummary {
  /** マージ済みの枚数 */
  readonly mergedCount: number;
  /** 着手からマージまでの中央値（`startedAt` と `mergedAt` がそろったカードだけ） */
  readonly leadTimeMedianMs: number | null;
  /** 着手からマージまでの最長 */
  readonly leadTimeMaxMs: number | null;
  /** マージ済みのカード 1 枚あたりの、人の区間の割合の中央値 */
  readonly humanShareMedian: number | null;
  /** 否決が 1 回以上あるカードの枚数（plan と verify の両方） */
  readonly rejectedCardCount: number;
  /** 否決の延べ回数 */
  readonly rejectionCount: number;
  /** アイデアの列に残っている枚数 */
  readonly ideaCount: number;
}

/** 工程 1 つの滞在時間。マージ済みのカードで、その工程を通ったものだけを数える */
export interface StageDuration {
  readonly kind: TimelineKind;
  readonly owner: TimelineOwner;
  /** カードごとに同じ種類の区間を足し、カードを並べた中央値 */
  readonly medianMs: number;
  /** 数えたカードの枚数 */
  readonly cardCount: number;
}

/** 1 日のマージ数。`date` は UTC の `YYYY-MM-DD` */
export interface DailyMerges {
  readonly date: string;
  readonly count: number;
}

/** ループの手の種類 1 つの集計。`implement` は段（`step`）ごとに分ける */
export interface LoopActionMetrics {
  readonly action: LoopAction;
  /** `implement` の段。`implement` 以外と、段の分からない `implement` は null */
  readonly step: LoopImplStep | null;
  readonly count: number;
  /** `durationMs` が null の記録を除いた平均。1 件も無ければ null */
  readonly avgDurationMs: number | null;
  /** 平均から除いた（`durationMs` が null の）件数 */
  readonly missingDuration: number;
  /** `tokens` が null の記録を除いた平均。1 件も無ければ null */
  readonly avgTokens: number | null;
  /** 平均から除いた（`tokens` が null の）件数 */
  readonly missingTokens: number;
}

/** 手の結果の内訳。`running` は終わっていない記録（`result` が null） */
export interface LoopResultCount {
  readonly result: LoopResult | 'running';
  readonly count: number;
}

export interface BoardMetrics {
  readonly summary: MetricsSummary;
  /** 工程ごとの滞在時間。`TIMELINE_KINDS` の順で、数えたカードの無い工程は入れない */
  readonly stages: readonly StageDuration[];
  /** 中央値がいちばん長い工程。同じ長さなら工程の順で前のもの。工程が無ければ null */
  readonly bottleneck: TimelineKind | null;
  /** 最初のマージの日から最後のマージの日まで、1 日ずつ（マージの無い日は 0） */
  readonly dailyMerges: readonly DailyMerges[];
  /** 手の種類ごと。`LOOP_ACTIONS` の順で、`implement` は `LOOP_IMPL_STEPS` の順、段の無いものを最後に置く。記録の無い種類は入れない */
  readonly loopActions: readonly LoopActionMetrics[];
  /** `LOOP_RESULTS` の順に `running` を足したもの。0 件の結果は入れない */
  readonly loopResults: readonly LoopResultCount[];
}

const REJECTED_KIND = '否決';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ボードのカードを集計する。
 *
 * 今の時刻は読まない。区間を数えるのはマージ済みのカードだけで、`end: null` の区間は
 * マージの時刻（読めなければ計画の最終更新）で閉じる。どちらも無いマージ済みのカードは、
 * 工程ごとの滞在時間と人の番の割合から除く（出し直すたびに伸び続けないように）。
 * 中止したカードはどの集計にも入れない。
 */
export function computeBoardMetrics(cards: readonly MetricsCard[]): BoardMetrics {
  const live = cards.filter((card) => !card.aborted);
  const merged = live.filter((card) => card.stage === 'merged');

  const stages = stageDurations(merged);

  return {
    summary: summarize(live, merged),
    stages,
    bottleneck: pickBottleneck(stages),
    dailyMerges: countDailyMerges(merged),
    loopActions: loopActionMetrics(live),
    loopResults: loopResultCounts(live),
  };
}

// ============================================================
// 主な数字
// ============================================================

function summarize(live: readonly MetricsCard[], merged: readonly MetricsCard[]): MetricsSummary {
  const leadTimes = merged
    .map((card) => leadTimeMs(card))
    .filter((value): value is number => value !== null);

  const shares = merged
    .map((card) => humanShare(card))
    .filter((value): value is number => value !== null);

  const rejections = live.map(
    (card) => card.reviews.filter((review) => review.kind === REJECTED_KIND).length
  );

  return {
    mergedCount: merged.length,
    leadTimeMedianMs: median(leadTimes),
    leadTimeMaxMs: leadTimes.length === 0 ? null : Math.max(...leadTimes),
    humanShareMedian: median(shares),
    rejectedCardCount: rejections.filter((count) => count > 0).length,
    rejectionCount: rejections.reduce((sum, count) => sum + count, 0),
    ideaCount: live.filter((card) => card.stage === 'idea').length,
  };
}

/** 着手からマージまで。どちらかの時刻が無いか読めなければ null */
function leadTimeMs(card: MetricsCard): number | null {
  const mergedAt = card.mrState?.mergedAt ?? null;
  if (card.startedAt === null || mergedAt === null) return null;

  const span = Date.parse(mergedAt) - Date.parse(card.startedAt);
  return Number.isNaN(span) ? null : span;
}

/**
 * マージ済みのカードの区間を閉じる時刻。マージの時刻が無ければ計画の最終更新（ボードの画面のマージ済みの時刻と同じ）。
 * どちらも無ければ null
 */
export function mergedEndOf(card: Pick<MetricsCard, 'mrState' | 'plan'>): string | null {
  return card.mrState?.mergedAt ?? card.plan?.updatedAt ?? null;
}

/** 人の区間の合計 ÷ 全区間の合計。区間の長さが 0 か、閉じる時刻が無ければ null */
function humanShare(card: MetricsCard): number | null {
  const end = mergedEndOf(card);
  if (end === null) return null;

  let human = 0;
  let total = 0;
  for (const segment of card.timeline) {
    const length = segmentMs(segment, end);
    total += length;
    if (segment.owner === 'human') human += length;
  }
  return total === 0 ? null : human / total;
}

// ============================================================
// 工程ごとの滞在時間
// ============================================================

/** マージ済みのカードの工程ごとの滞在時間。`end: null` の区間はマージの時刻で閉じ、その時刻が無いカードは除く */
function stageDurations(merged: readonly MetricsCard[]): readonly StageDuration[] {
  const perKind = new Map<TimelineKind, number[]>();
  for (const card of merged) {
    const end = mergedEndOf(card);
    if (end === null) continue;

    const totals = new Map<TimelineKind, number>();
    for (const segment of card.timeline) {
      totals.set(segment.kind, (totals.get(segment.kind) ?? 0) + segmentMs(segment, end));
    }
    for (const [kind, total] of totals) {
      perKind.set(kind, [...(perKind.get(kind) ?? []), total]);
    }
  }

  const durations: StageDuration[] = [];
  for (const kind of TIMELINE_KINDS) {
    const values = perKind.get(kind);
    const medianMs = values === undefined ? null : median(values);
    if (values === undefined || medianMs === null) continue;
    durations.push({ kind, owner: TIMELINE_OWNERS[kind], medianMs, cardCount: values.length });
  }
  return durations;
}

/** 中央値がいちばん長い工程。`stages` は工程の順なので、同じ長さなら先に出たものを残す */
function pickBottleneck(stages: readonly StageDuration[]): TimelineKind | null {
  let best: StageDuration | null = null;
  for (const stage of stages) {
    if (best === null || stage.medianMs > best.medianMs) best = stage;
  }
  return best?.kind ?? null;
}

// ============================================================
// 日ごとのマージ数
// ============================================================

function countDailyMerges(merged: readonly MetricsCard[]): readonly DailyMerges[] {
  const counts = new Map<string, number>();
  for (const card of merged) {
    const date = utcDate(card.mrState?.mergedAt ?? null);
    if (date !== null) counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  if (counts.size === 0) return [];

  const dates = [...counts.keys()].sort();
  const first = Date.parse(`${dates[0]}T00:00:00.000Z`);
  const last = Date.parse(`${dates[dates.length - 1]}T00:00:00.000Z`);

  const days: DailyMerges[] = [];
  for (let at = first; at <= last; at += DAY_MS) {
    const date = new Date(at).toISOString().slice(0, 10);
    days.push({ date, count: counts.get(date) ?? 0 });
  }
  return days;
}

// ============================================================
// ループの手
// ============================================================

type LoopStepInput = MetricsCard['loopSteps'][number];

/** 手の種類の並び。`implement` は段ごとに分け、段の分からないものを最後に置く */
interface LoopActionKey {
  readonly action: LoopAction;
  readonly step: LoopImplStep | null;
}

const LOOP_ACTION_KEYS: readonly LoopActionKey[] = LOOP_ACTIONS.flatMap(
  (action): LoopActionKey[] =>
    action === 'implement'
      ? [...LOOP_IMPL_STEPS.map((step) => ({ action, step })), { action, step: null }]
      : [{ action, step: null }]
);

function loopActionMetrics(live: readonly MetricsCard[]): readonly LoopActionMetrics[] {
  const steps = live.flatMap((card) => card.loopSteps);

  const metrics: LoopActionMetrics[] = [];
  for (const key of LOOP_ACTION_KEYS) {
    const matched = steps.filter((step) => step.action === key.action && stepOf(step) === key.step);
    if (matched.length === 0) continue;

    const durations = matched.flatMap((step) =>
      step.durationMs === null ? [] : [step.durationMs]
    );
    const tokens = matched.flatMap((step) => (step.tokens === null ? [] : [step.tokens]));
    metrics.push({
      action: key.action,
      step: key.step,
      count: matched.length,
      avgDurationMs: mean(durations),
      missingDuration: matched.length - durations.length,
      avgTokens: mean(tokens),
      missingTokens: matched.length - tokens.length,
    });
  }
  return metrics;
}

/** `implement` 以外の手は段を持たないものとして数える */
function stepOf(step: LoopStepInput): LoopImplStep | null {
  return step.action === 'implement' ? step.step : null;
}

function loopResultCounts(live: readonly MetricsCard[]): readonly LoopResultCount[] {
  const steps = live.flatMap((card) => card.loopSteps);
  const keys: readonly (LoopResult | 'running')[] = [...LOOP_RESULTS, 'running'];

  return keys
    .map((result) => ({
      result,
      count: steps.filter((step) => (step.result ?? 'running') === result).length,
    }))
    .filter((entry) => entry.count > 0);
}

// ============================================================
// 小さな関数
// ============================================================

/** 中央値。偶数個なら真ん中の 2 つの平均。空なら null */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] as number;

  return sorted.length % 2 === 1 ? upper : ((sorted[middle - 1] as number) + upper) / 2;
}

/** 平均。空なら null */
function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * 区間の長さ（ミリ秒）。`end` が null（今いる区間）なら `generatedAt` までを数える。
 * 時刻が読めないか、終わりが始まりより前なら 0
 */
export function segmentMs(
  segment: Pick<TimelineSegment, 'start' | 'end'>,
  generatedAt: string
): number {
  const span = Date.parse(segment.end ?? generatedAt) - Date.parse(segment.start);
  return Number.isNaN(span) || span < 0 ? 0 : span;
}

/** ISO 8601 の時刻の UTC の日付（`YYYY-MM-DD`）。読めなければ null */
export function utcDate(iso: string | null): string | null {
  if (iso === null) return null;

  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at.toISOString().slice(0, 10);
}
