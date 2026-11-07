import type { Decision } from '../../shared/board-sections.js';
import type { Stage } from '../../shared/schemas/common.js';
import type { BoardLoop } from '../../shared/loop-activity.js';
import type { NextAction } from '../services/next-action.js';
import type { BoardCard } from './board-card.js';
import type { ForgeConnection } from './pr-state.js';

// ============================================================
// ボードの見せる形 — 判断待ち・作業中・アイデアの表・次の一手（`ai-board status` が出す）
// ============================================================

export interface CardSummary {
  readonly id: string;
  readonly title: string;
  readonly stage: Stage;
  readonly reason: string;
  /** ループが今このカードを触っているか（終わっていない 1 手の記録がある） */
  readonly running: boolean;
}

/**
 * 人の番のカード。判断を待つ列（計画レビュー / PR中）のカードと、
 * AI の列で止まっているカード（`hold`。ループはこれを選ばない）。
 * `decisions` は `ai-board decide` が受け付ける判断と同じもの（`decisionsFor`）。PR中 のカードは空
 */
export interface WaitingCard extends CardSummary {
  readonly decisions: readonly Decision[];
}

export type StatusCard = Omit<BoardCard, 'body'>;

/** AI が進めているカード。`stale` はしばらく動きが無いもの */
export interface WorkingCard extends CardSummary {
  readonly stale: boolean;
}

/** アイデアの表の 1 行。`ideaRows` と同じ順で、区切り線も 1 行として入る */
export type IdeaListRow =
  { readonly id: string; readonly title: string } | { readonly divider: true };

export interface StatusReport {
  /** ループが次に進めるもの。無いか、GitHub につながっていなければ null */
  readonly next: NextAction | null;
  readonly waiting: readonly WaitingCard[];
  readonly working: readonly WorkingCard[];
  readonly cards: readonly StatusCard[];
  readonly ideas: readonly IdeaListRow[];
  readonly forge: ForgeConnection;
  /** ループの様子（今触っている手と、最後に手を終えた時刻）。各カードの手の一覧は `cards[].loopSteps` */
  readonly loop: BoardLoop;
  readonly generatedAt: string;
}
