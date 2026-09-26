import type { Stage } from './schemas/common.js';

// ============================================================
// ダッシュボードの区画 — web とテストの両方から使う純関数
// ============================================================

/**
 * ダッシュボードの区画。ステージの導出はサーバが済ませており、ここは見せ方の振り分けだけを持つ。
 *
 * - `inbox`   人の判断待ち（計画レビュー / PR中）
 * - `work`    AI が進めている（計画提案中 / 実装中）
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
    sections[card.aborted ? 'aborted' : SECTION_OF_STAGE[card.stage]].push(card);
  }

  return {
    ...sections,
    inbox: sortByTime(sections.inbox, waitingSince, 'asc'),
    merged: sortByTime(sections.merged, mergedAt, 'desc'),
  };
}

/**
 * 人を待ち始めた時刻。
 *
 * 計画レビューは提出（再提出）の時刻。提出を書き忘れて計画ファイルだけがある場合は
 * ファイルの更新時刻で代える。
 * PR中 は最新コミットの時刻（修正を push した時点から人の番になる）。取れなければ計画の提出時刻。
 */
export function waitingSince(card: SectionCard): string | null {
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
