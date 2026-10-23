import type { Stage } from '../../shared/schemas/common.js';
import type { GateState } from '../../cards/models/review.js';

// ============================================================
// 次の一手 — ループが 1 周で進めるものを決める純関数
// ============================================================

/**
 * ループが 1 周で行う作業の種類。
 *
 * - `implement`   実装中。計画の次の未チェックのタスクを 1 つ倒す（全部倒れていれば Ready にする）
 * - `plan`        計画提案中で、まだ何も提出していない。計画を書いて Draft の PR を出し、提出する
 * - `revise-plan` 計画提案中で、最新の判断が 否決。理由を読んで計画を直し、再提出する
 */
export type NextActionKind = 'implement' | 'plan' | 'revise-plan';

export interface NextAction {
  readonly cardId: string;
  readonly action: NextActionKind;
  readonly reason: string;
}

/** AI の列にいるのに、ループが推測で手を出さないカード */
export interface StuckCard {
  readonly cardId: string;
  readonly reason: string;
}

/** 判定に要るフィールドだけ。サーバの BoardCard が満たす */
export interface NextActionCard {
  readonly id: string;
  readonly stage: Stage;
  readonly aborted: boolean;
  readonly gates: { readonly plan: GateState };
}

type Verdict = NextAction | StuckCard | null;

/** 上の列ほど優先する。進んだカードを先に片付け、仕掛かりを増やさない */
const PRIORITY: readonly Stage[] = ['impling', 'planning'];

/**
 * 次に進めるカードを 1 枚選ぶ。
 *
 * `cards` は `rank` の実効値の順に並んでいる前提で、同じ列の中はその順を保つ。
 * 中止のカードと、人の判断を待つ列（計画レビュー / PR中）は選ばない。
 */
export function pickNextAction(cards: readonly NextActionCard[]): NextAction | null {
  for (const stage of PRIORITY) {
    for (const card of cards) {
      if (card.stage !== stage) continue;

      const verdict = judge(card);
      if (verdict !== null && 'action' in verdict) {
        return verdict;
      }
    }
  }

  return null;
}

/**
 * AI の列にいるのに、ループが手を出さないカード。人に知らせるために使う。
 *
 * 計画提案中で plan ゲートが提出済みなのは、提出したのに計画ファイルも
 * Draft の PR も見えない状態である（どちらかがあれば 計画レビュー に上がる）。
 * 作り直すと PR やブランチを二重に作りかねないので、推測で動かない。
 */
export function findStuckCards(cards: readonly NextActionCard[]): StuckCard[] {
  return cards
    .map(judge)
    .filter((verdict): verdict is StuckCard => verdict !== null && !('action' in verdict));
}

function judge(card: NextActionCard): Verdict {
  if (card.aborted) return null;

  if (card.stage === 'impling') {
    return { cardId: card.id, action: 'implement', reason: '計画が承認されている' };
  }

  if (card.stage !== 'planning') return null;

  switch (card.gates.plan) {
    case 'none':
      return { cardId: card.id, action: 'plan', reason: '着手が指示され、計画がまだ無い' };
    case 'rejected':
      return { cardId: card.id, action: 'revise-plan', reason: '計画が否決された' };
    case 'submitted':
      return {
        cardId: card.id,
        reason: '計画を提出済みだが、計画ファイルも Draft の PR も見えない',
      };
    case 'approved':
      // 承認なら 実装中 に上がっているので、ここには来ない
      return null;
  }
}
