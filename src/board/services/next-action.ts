import type { Stage } from '../../shared/schemas/common.js';
import type { GateState, ReviewGate } from '../../cards/models/review.js';

// ============================================================
// 次の一手 — ループが 1 周で進めるものを決める純関数
// ============================================================

/**
 * ループが 1 周で行う作業の種類。
 *
 * - `implement`   実装中で、動作確認をまだ頼んでいない。計画の次の未チェックのタスクを 1 つ倒す
 *                 （全部倒れていれば動作確認を頼む。verify を飛ばす宣言があれば Ready にする）
 * - `revise-impl` 実装中で、動作確認の最新の判断が 否決。理由を読んで直し、動作確認を頼み直す
 * - `ready`       実装中で、動作確認を人が承認した。計画を archive へ移し、PR を Ready にする
 * - `plan`        計画提案中で、まだ何も提出していない。計画を書いて Draft の PR を出し、提出する
 * - `revise-plan` 計画提案中で、最新の判断が 否決。理由を読んで計画を直し、再提出する
 */
export type NextActionKind = 'implement' | 'revise-impl' | 'ready' | 'plan' | 'revise-plan';

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
  readonly gates: { readonly plan: GateState; readonly verify: GateState };
  /** gates の approved が人の承認か飛ばす宣言かを見分けるのに使う */
  readonly skipGates: readonly ReviewGate[];
}

type Verdict = NextAction | StuckCard | null;

/** 上の列ほど優先する。進んだカードを先に片付け、仕掛かりを増やさない */
const PRIORITY: readonly Stage[] = ['impling', 'planning'];

/**
 * 次に進めるカードを 1 枚選ぶ。
 *
 * `cards` は `rank` の実効値の順に並んでいる前提で、同じ列の中はその順を保つ。
 * 中止のカードと、人の判断を待つ列（計画レビュー / 動作確認 / PR中）は選ばない。
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

  switch (card.stage) {
    case 'impling':
      return judgeImpling(card);
    case 'planning':
      return judgePlanning(card);
    default:
      return null;
  }
}

/**
 * 実装中のカードの手を verify ゲートの状態で分ける。
 *
 * 計画のタスクの進み具合では分けない。計画ファイルは作業用のブランチにあり、
 * ボードを動かすチェックアウトからは読めないことが多いため。
 * `gateState` は飛ばす宣言も approved で返すので、人の承認とは `skipGates` で見分ける。
 * 飛ばす宣言ならタスクが残っているかもしれないので `implement` のままにする。
 */
function judgeImpling(card: NextActionCard): Verdict {
  switch (card.gates.verify) {
    case 'none':
      return { cardId: card.id, action: 'implement', reason: '計画が承認されている' };
    case 'rejected':
      return { cardId: card.id, action: 'revise-impl', reason: '動作確認で否決された' };
    case 'approved':
      return card.skipGates.includes('verify')
        ? { cardId: card.id, action: 'implement', reason: '計画が承認され、動作確認は飛ばす' }
        : { cardId: card.id, action: 'ready', reason: '動作確認が承認された' };
    case 'submitted':
      // 提出済みなら 動作確認 に上がっているので、ここには来ない
      return null;
  }
}

function judgePlanning(card: NextActionCard): Verdict {
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
