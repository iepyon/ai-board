import type { Stage } from '../../shared/schemas/common.js';
import type { CardHold } from './next-action.js';

// ============================================================
// ボードの区画 — `status` と `decide` が使う純関数（区画・並び・動きなし）
// ============================================================

/**
 * ボードの区画。ステージの導出は済んでおり、ここは見せ方の振り分けだけを持つ。
 *
 * - `inbox`   人の判断待ち（計画レビュー / PR中、と AI の列で止まっているカード）
 * - `work`    AI が進めている（計画提案中 / 実装中。止まっているカードを除く。PR中 で人の指摘に AI が応える番のカードを含む）
 * - `idea`    アイデア
 * - `merged`  マージ済み
 * - `aborted` 中止。どのステージにあってもここへ寄せる（終端であり、判断も作業も待っていない）
 */
export type BoardSection = 'inbox' | 'work' | 'idea' | 'merged' | 'aborted';

/** 中止でないカードがステージから入る区画 */
export const SECTION_OF_STAGE: Record<Stage, Exclude<BoardSection, 'aborted'>> = {
  idea: 'idea',
  planning: 'work',
  'plan-review': 'inbox',
  impling: 'work',
  pr: 'inbox',
  merged: 'merged',
};

/** 振り分けと並べ替えに要るフィールドだけ。`BoardCard` が満たす */
export interface SectionCard {
  readonly id: string;
  readonly stage: Stage;
  readonly aborted: boolean;
  readonly startedAt: string | null;
  readonly latestReview: { readonly at: string } | null;
  readonly plan: { readonly updatedAt: string } | null;
  readonly prState: {
    readonly latestCommitAt: string | null;
    readonly mergedAt: string | null;
    /** PR中 で、人の指摘に AI が応える番か（`awaitsPrFix`） */
    readonly awaitingFix: boolean;
  } | null;
  /**
   * AI の列にいるが人の判断を待っているときの止まり（`resolveHold`）。
   * `kind` が `forge`（PR の状態を引けない）なら出せる判断は無い
   */
  readonly hold: CardHold | null;
}

export type Sections<T> = Record<BoardSection, T[]>;

/**
 * カードを区画へ振り分ける。
 *
 * 受け取った並び（`rank` の順）を保つ。判断待ちとマージ済みだけは、
 * 人が片付ける順・振り返る順に並べ直す。
 * AI が進めている区画では、PR の指摘に応えるカードを先頭に寄せる（ループもそれを先に選ぶ。マージに最も近いため）。
 */
export function groupBySection<T extends SectionCard>(cards: readonly T[]): Sections<T> {
  const sections: Sections<T> = { inbox: [], work: [], idea: [], merged: [], aborted: [] };

  for (const card of cards) {
    sections[sectionOf(card)].push(card);
  }

  return {
    ...sections,
    inbox: sortByTime(sections.inbox, waitingSince, 'asc'),
    work: [
      ...sections.work.filter(isAwaitingPrFix),
      ...sections.work.filter((card) => !isAwaitingPrFix(card)),
    ],
    merged: sortByTime(sections.merged, mergedAt, 'desc'),
  };
}

/**
 * カードの入る区画。中止が最も強く、次に止まり、次に PR の指摘、最後にステージで決める。
 * 止まっているカードはステージが AI の列のままでも、人の判断を待っているので判断待ちに出す。
 * PR中 のカードは人の列だが、人の指摘に AI が応える番なら AI が進めている区画に出す。
 * 件数帯の飛び先（`SECTION_OF_STAGE`）はステージだけで決め、PR中 のマスは判断待ちへ飛ぶ。
 */
function sectionOf(card: SectionCard): BoardSection {
  if (card.aborted) return 'aborted';
  if (card.hold !== null) return 'inbox';
  if (isAwaitingPrFix(card)) return 'work';

  return SECTION_OF_STAGE[card.stage];
}

/** PR中 で、人の指摘に AI が応える番のカードか */
export function isAwaitingPrFix(card: Pick<SectionCard, 'stage' | 'prState'>): boolean {
  return card.stage === 'pr' && card.prState?.awaitingFix === true;
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
    return card.prState?.latestCommitAt ?? card.latestReview?.at ?? null;
  }

  return card.latestReview?.at ?? card.plan?.updatedAt ?? null;
}

/**
 * マージされた時刻。PR の `merged_at`、無ければ archive された計画ファイルの更新時刻。
 * PR を経ずに archive だけでマージ済みになったカードもあるため。
 */
export function mergedAt(card: SectionCard): string | null {
  return card.prState?.mergedAt ?? card.plan?.updatedAt ?? null;
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
  // PR の指摘に応えるカードの計画は archive 済みで更新されない。指摘を受けたばかりなので、動きなしと読まない
  if (isAwaitingPrFix(card)) return false;

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
