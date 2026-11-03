import type { Stage } from './schemas/common.js';
import { DIVIDER_ID } from './card-reorder.js';

// ============================================================
// ダッシュボードの区画 — web とテストの両方から使う純関数
// ============================================================

/**
 * ダッシュボードの区画。ステージの導出はサーバが済ませており、ここは見せ方の振り分けだけを持つ。
 *
 * - `inbox`   人の判断待ち（計画レビュー / PR中、と AI の列で止まっているカード）
 * - `work`    AI が進めている（計画提案中 / 実装中。止まっているカードを除く）
 * - `idea`    アイデア
 * - `merged`  マージ済み
 * - `aborted` 中止。どのステージにあってもここへ寄せる（終端であり、判断も作業も待っていない）
 */
export type DashboardSection = 'inbox' | 'work' | 'idea' | 'merged' | 'aborted';

/** 中止でないカードがステージから入る区画。件数帯のマスから飛ぶ先にも使う */
export const SECTION_OF_STAGE: Record<Stage, Exclude<DashboardSection, 'aborted'>> = {
  idea: 'idea',
  planning: 'work',
  'plan-review': 'inbox',
  impling: 'work',
  pr: 'inbox',
  merged: 'merged',
};

/** 振り分けと並べ替えに要るフィールドだけ。サーバの BoardCard と web の型の両方が満たす */
export interface SectionCard {
  readonly id: string;
  readonly stage: Stage;
  readonly aborted: boolean;
  readonly startedAt: string | null;
  readonly latestReview: { readonly at: string } | null;
  readonly plan: { readonly updatedAt: string } | null;
  readonly mrState: {
    readonly latestCommitAt: string | null;
    readonly mergedAt: string | null;
  } | null;
  /**
   * AI の列にいるが人の判断を待っているときの止まり（サーバの `resolveHold`）。
   * `src/shared/` は web からも読むので、サーバの型を import せず形だけを書く
   */
  readonly hold: { readonly reason: string; readonly since: string } | null;
}

export type Sections<T> = Record<DashboardSection, T[]>;

/**
 * カードを区画へ振り分ける。
 *
 * 受け取った並び（`rank` の順）を保つ。判断待ちとマージ済みだけは、
 * 人が片付ける順・振り返る順に並べ直す。
 */
export function groupBySection<T extends SectionCard>(cards: readonly T[]): Sections<T> {
  const sections: Sections<T> = { inbox: [], work: [], idea: [], merged: [], aborted: [] };

  for (const card of cards) {
    sections[sectionOf(card)].push(card);
  }

  return {
    ...sections,
    inbox: sortByTime(sections.inbox, waitingSince, 'asc'),
    merged: sortByTime(sections.merged, mergedAt, 'desc'),
  };
}

/**
 * カードの入る区画。中止が最も強く、次に止まり、最後にステージで決める。
 * 止まっているカードはステージが AI の列のままでも、人の判断を待っているので判断待ちに出す。
 */
function sectionOf(card: SectionCard): DashboardSection {
  if (card.aborted) return 'aborted';
  if (card.hold !== null) return 'inbox';

  return SECTION_OF_STAGE[card.stage];
}

/**
 * 人を待ち始めた時刻。
 *
 * 止まっているカードは止まりの起点（`hold.since`）。
 *
 * 計画レビューは提出（再提出）の時刻。提出を書き忘れて計画ファイルだけがある場合は
 * ファイルの更新時刻で代える。
 * PR中 は最新コミットの時刻（修正を push した時点から人の番になる）。取れなければゲートを問わず最新のレビューエントリの時刻
 * （多くは plan の承認）。
 */
export function waitingSince(card: SectionCard): string | null {
  if (card.hold !== null) return card.hold.since;

  if (card.stage === 'pr') {
    return card.mrState?.latestCommitAt ?? card.latestReview?.at ?? null;
  }

  return card.latestReview?.at ?? card.plan?.updatedAt ?? null;
}

/**
 * マージされた時刻。PR の `merged_at`、無ければ archive された計画ファイルの更新時刻。
 * PR を経ずに archive だけでマージ済みになったカードもあるため。
 */
export function mergedAt(card: SectionCard): string | null {
  return card.mrState?.mergedAt ?? card.plan?.updatedAt ?? null;
}

// ============================================================
// 判断のボタン
// ============================================================

/** 人が判断するゲート。`ReviewGate`（`src/cards/models/review.ts`）と同じ値をリテラルで書く */
export type DecisionGate = 'plan';

/**
 * 詳細パネルに出す判断のボタン 1 つ。押すと `## レビュー` へ `gate` の `kind` を追記する。
 *
 * plan の否決は、計画提案中へ落として計画を直させる（`revise-plan`）。
 * 実装中のカードに書けば、承認済みの計画から立て直させることになる。
 */
export interface Decision {
  readonly gate: DecisionGate;
  readonly kind: '承認' | '否決' | '中止';
  readonly label: string;
  /** 理由を書かないと押せないか。否決は AI が次の周回で理由を読むので必須 */
  readonly reasonRequired: boolean;
}

/** ボタンを決めるのに要るフィールドだけ。サーバの BoardCard と web の型の両方が満たす */
export interface DecisionCard extends Pick<SectionCard, 'stage' | 'aborted' | 'hold'> {
  readonly gates: {
    readonly plan: 'none' | 'submitted' | 'held' | 'approved' | 'rejected';
  };
}

const approve = (gate: DecisionGate): Decision => ({
  gate,
  kind: '承認',
  label: '承認',
  reasonRequired: false,
});

const reject = (gate: DecisionGate, label: string): Decision => ({
  gate,
  kind: '否決',
  label,
  reasonRequired: true,
});

const abort = (gate: DecisionGate): Decision => ({
  gate,
  kind: '中止',
  label: '中止する',
  reasonRequired: false,
});

/** 承認済みの計画を否決し、計画提案中へ落として計画から立て直させる */
const replan = reject('plan', '計画から立て直させる');

/**
 * 詳細パネルに出す判断のボタン。判断を待っていなければ空。
 *
 * - **計画レビュー**: 承認 / 否決して差し戻す / 中止
 * - **実装中で止まっている**（判断の後に PR が Draft に戻された）: 計画から立て直させる / 中止
 * - **計画提案中で止まっている**: AI の plan 保留なら 計画を直させる / 中止。
 *   提出済みなのに成果物が見えないなら 中止 だけ（直させる先の計画が見えない）
 *
 * PR中 のカードは GitHub で PR をマージして判断するので出さない。中止のカードにも出さない。
 *
 * 飛ばす宣言（`skipGates`）の有無では出し分けない。
 * 宣言のあるゲートでも、AI の 提出 / 再提出 を承認と読むだけで、人の否決 / 承認はふつうに効く（`gateState`）。
 * plan を飛ばすカードでも「計画から立て直させる」を押せる。
 */
export function decisionsFor(card: DecisionCard): Decision[] {
  if (card.aborted) return [];

  switch (card.stage) {
    case 'plan-review':
      return [approve('plan'), reject('plan', '否決して差し戻す'), abort('plan')];
    case 'impling':
      return card.hold === null ? [] : [replan, abort('plan')];
    case 'planning':
      if (card.hold === null) return [];
      return card.gates.plan === 'held'
        ? [reject('plan', '計画を直させる'), abort('plan')]
        : [abort('plan')];
    default:
      return [];
  }
}

/**
 * 詳細パネルで、判断のボタンを本文より前に出すか。出すボタン（`decisionsFor`）が 1 つでもあれば出す。
 *
 * ゲートを待つ列（計画レビュー）のカードと、AI の列で止まっているカードが当たる。
 */
export function awaitsDecision(card: DecisionCard): boolean {
  return decisionsFor(card).length > 0;
}

/** 「動きなし」とみなすまでの日数 */
export const STALE_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * AI が進めているはずのカードが、しばらく動いていないか。
 *
 * 実装中は計画ファイルの更新時刻、計画提案中は（計画がまだ無いので）着手の時刻を見る。
 */
export function isStale(card: SectionCard, now: Date, days: number = STALE_DAYS): boolean {
  const since = card.plan?.updatedAt ?? card.startedAt;
  if (since === null) return false;

  const at = Date.parse(since);

  return !Number.isNaN(at) && now.getTime() - at >= days * DAY_MS;
}

/**
 * 時刻で安定に並べる。時刻の取れないカードは末尾に元の順で置く
 * （先頭に置くと、判断待ちの区画で何も分からないカードが一番目立つ）。
 */
function sortByTime<T extends SectionCard>(
  cards: readonly T[],
  timeOf: (card: T) => string | null,
  order: 'asc' | 'desc'
): T[] {
  const sign = order === 'asc' ? 1 : -1;

  return cards
    .map((card, index) => ({ card, index, at: parseTime(timeOf(card)) }))
    .sort((a, b) => {
      if (a.at === null || b.at === null) {
        return a.at === b.at ? a.index - b.index : a.at === null ? 1 : -1;
      }
      return (a.at - b.at) * sign || a.index - b.index;
    })
    .map(({ card }) => card);
}

function parseTime(value: string | null): number | null {
  if (value === null) return null;

  const at = Date.parse(value);

  return Number.isNaN(at) ? null : at;
}

// ============================================================
// アイデアの区切り線
// ============================================================

/** アイデアを区切り線の上下に分けたもの */
export interface IdeaTiers<T> {
  /** 区切り線より上。次に着手する候補 */
  readonly next: T[];
  /** 区切り線より下。あとで考える */
  readonly later: T[];
}

/**
 * `rank` の順に並んだアイデアを、区切り線 `divider`（rank の値）の上下に分ける。
 *
 * 比べるのは並び順の実効値（`rank`、無ければ `created` のエポックミリ秒。
 * サーバの `effectiveRank` と同じ規則）。区切り線が未設定なら末尾にあるものとみなし、
 * すべて「次にやる」に入れる。区分は見せ方だけのもので、ステージの導出には使わない。
 */
export function splitIdeas<T extends { readonly rank: number | null; readonly created: string }>(
  ideas: readonly T[],
  divider: number | null
): IdeaTiers<T> {
  if (divider === null) return { next: [...ideas], later: [] };

  const next: T[] = [];
  const later: T[] = [];

  for (const idea of ideas) {
    (effectiveRankOf(idea) < divider ? next : later).push(idea);
  }

  return { next, later };
}

/** アイデアの表の 1 行。カードか区切り線 */
export type IdeaRow<T> =
  | { readonly kind: 'card'; readonly id: string; readonly card: T }
  | { readonly kind: 'divider'; readonly id: typeof DIVIDER_ID };

/**
 * アイデアの表に並べる行。「次にやる」のカード、区切り線、「あとで考える」のカードの順。
 *
 * 区切り線はカードと同じ 1 行として並びに入れるので、並べ替え（`moveTargetFor` / `applyMove`）を
 * そのまま使える。未設定の区切り線は末尾に置く。
 */
export function ideaRows<
  T extends { readonly id: string; readonly rank: number | null; readonly created: string },
>(ideas: readonly T[], divider: number | null): IdeaRow<T>[] {
  const { next, later } = splitIdeas(ideas, divider);
  const toRow = (card: T): IdeaRow<T> => ({ kind: 'card', id: card.id, card });

  return [...next.map(toRow), { kind: 'divider', id: DIVIDER_ID }, ...later.map(toRow)];
}

function effectiveRankOf(card: { readonly rank: number | null; readonly created: string }): number {
  return card.rank ?? Date.parse(card.created);
}
