import type { Stage } from '../../shared/schemas/common.js';
import type { GateState, ReviewEntry, ReviewGate } from '../../cards/models/review.js';
import { latestGateEntry } from '../../cards/services/review-log.js';

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

/**
 * AI の列（計画提案中 / 実装中）にいるが、人の判断を待っているカードの止まり。
 *
 * ステージではない。ステージは「工程のどこにいるか」、止まりは「その工程で誰を待っているか」で、軸が違う。
 * どこにも保存せず、ボードを組み立てるたびに `resolveHold` で導く。
 */
export interface CardHold {
  /** 人が何をすればよいか */
  readonly reason: string;
  /** 人を待ち始めた時刻 */
  readonly since: string;
}

/** 判定に要るフィールドだけ。サーバの BoardCard が満たす */
export interface NextActionCard {
  readonly id: string;
  readonly stage: Stage;
  readonly aborted: boolean;
  readonly gates: { readonly plan: GateState; readonly verify: GateState };
  /** gates の approved が人の承認か飛ばす宣言かを見分けるのに使う */
  readonly skipGates: readonly ReviewGate[];
  /** 人の判断を待っていれば、その止まり。`resolveHold` で導く */
  readonly hold: CardHold | null;
}

/** 止まりの判定に要るもの */
export interface HoldInput {
  readonly stage: Stage;
  readonly aborted: boolean;
  readonly gates: { readonly plan: GateState; readonly verify: GateState };
  /** カード本文の `## レビュー` のエントリ */
  readonly entries: readonly ReviewEntry[];
  /** PR の状態のうち、Draft に戻されたことの判定に要るもの。PR が無ければ null */
  readonly mr: { readonly iid: number; readonly convertedToDraftAt: string | null } | null;
}

/** 止まりの理由。人が何をすればよいかを書く */
export const HOLD_REASONS = {
  verifyHeld:
    '作業者が直しきれずに止まった。実装を直させるか、計画から立て直させるか、中止するかを選んでください',
  planHeld:
    '作業者が計画を直しきれずに止まった。否決の理由を足して直させるか、中止するかを選んでください',
  planLost: '計画を提出済みだが、計画ファイルも Draft の PR も見えない',
  draftReverted: (iid: number): string =>
    `判断の後に PR #${iid} が Draft に戻された。Ready に戻すか、実装を直させるか、計画から立て直させてください`,
} as const;

/** 上の列ほど優先する。進んだカードを先に片付け、仕掛かりを増やさない */
const PRIORITY: readonly Stage[] = ['impling', 'planning'];

/**
 * 次に進めるカードを 1 枚選ぶ。
 *
 * `cards` は `rank` の実効値の順に並んでいる前提で、同じ列の中はその順を保つ。
 * 中止のカード、止まっているカード（`hold`）、人の判断を待つ列（計画レビュー / 動作確認 / PR中）は選ばない。
 * 止まっているカードを飛ばすので、1 枚が止まっても後ろのカードは進む。
 */
export function pickNextAction(cards: readonly NextActionCard[]): NextAction | null {
  for (const stage of PRIORITY) {
    for (const card of cards) {
      if (card.stage !== stage || card.hold !== null) continue;

      const action = judge(card);
      if (action !== null) return action;
    }
  }

  return null;
}

/**
 * AI の列にいるのに、ループが手を出さないカード（`hold` のあるカード）。人に知らせるために使う。
 */
export function findStuckCards(cards: readonly NextActionCard[]): StuckCard[] {
  return cards.flatMap((card) =>
    card.hold === null ? [] : [{ cardId: card.id, reason: card.hold.reason }]
  );
}

/**
 * AI の列にいるカードが、人の判断を待って止まっているか。止まっていなければ null。
 *
 * - **PR が Draft に戻された**（実装中）: 人の最新の判断より後に PR が Draft に戻された。
 *   動作確認の承認や飛ばす宣言より先に見る。見ないと `ready` や `implement` が Ready にし直してしまう
 * - **verify 保留 / plan 保留**: 作業者が保留を書いて止まった。同じ手を渡しても作業者はまた止まる
 * - **提出済みなのに成果物が見えない**（計画提案中で plan が提出済み）: どちらかがあれば
 *   計画レビュー に上がるはずである。作り直すと PR やブランチを二重に作りかねないので、推測で動かない
 *
 * 人が否決・承認・中止を書けば、そのエントリが最新になって止まりは外れる。
 */
export function resolveHold(card: HoldInput): CardHold | null {
  if (card.aborted) return null;

  switch (card.stage) {
    case 'impling':
      return draftReverted(card) ?? heldBy(card, 'verify', HOLD_REASONS.verifyHeld);
    case 'planning':
      return card.gates.plan === 'submitted'
        ? since(card, 'plan', HOLD_REASONS.planLost)
        : heldBy(card, 'plan', HOLD_REASONS.planHeld);
    default:
      return null;
  }
}

/**
 * 人の最新の判断より後に PR が Draft に戻されたか。
 *
 * 作成時から Draft の PR は `convert_to_draft` を残さないので、動作確認を頼むあいだの Draft では止まらない。
 * レビューのエントリが 1 件も無いカード（plan を飛ばす宣言など）は、戻された時点で止まる。
 */
function draftReverted(card: HoldInput): CardHold | null {
  const { mr } = card;
  if (mr === null || mr.convertedToDraftAt === null) return null;

  const convertedAt = mr.convertedToDraftAt;
  const latest = latestGateEntry(card.entries, undefined);
  if (latest !== null && Date.parse(convertedAt) <= Date.parse(latest.at)) return null;

  return { reason: HOLD_REASONS.draftReverted(mr.iid), since: convertedAt };
}

function heldBy(card: HoldInput, gate: ReviewGate, reason: string): CardHold | null {
  return card.gates[gate] === 'held' ? since(card, gate, reason) : null;
}

/** 止まりの起点はそのゲートの最新エントリ（保留や提出）の時刻 */
function since(card: HoldInput, gate: ReviewGate, reason: string): CardHold | null {
  const entry = latestGateEntry(card.entries, gate);
  return entry === null ? null : { reason, since: entry.at };
}

function judge(card: NextActionCard): NextAction | null {
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
function judgeImpling(card: NextActionCard): NextAction | null {
  switch (card.gates.verify) {
    case 'none':
      return { cardId: card.id, action: 'implement', reason: '計画が承認されている' };
    case 'rejected':
      return { cardId: card.id, action: 'revise-impl', reason: '動作確認で否決された' };
    case 'approved':
      return card.skipGates.includes('verify')
        ? { cardId: card.id, action: 'implement', reason: '計画が承認され、動作確認は飛ばす' }
        : { cardId: card.id, action: 'ready', reason: '動作確認が承認された' };
    case 'held':
      // 止まり（`resolveHold`）として扱い、pickNextAction がここへ来る前に飛ばす
      return null;
    case 'submitted':
      // 提出済みなら 動作確認 に上がっているので、ここには来ない
      return null;
  }
}

function judgePlanning(card: NextActionCard): NextAction | null {
  switch (card.gates.plan) {
    case 'none':
      return { cardId: card.id, action: 'plan', reason: '着手が指示され、計画がまだ無い' };
    case 'rejected':
      return { cardId: card.id, action: 'revise-plan', reason: '計画が否決された' };
    case 'submitted':
    case 'held':
      // 止まり（`resolveHold`）として扱い、pickNextAction がここへ来る前に飛ばす
      return null;
    case 'approved':
      // 承認なら 実装中 に上がっているので、ここには来ない
      return null;
  }
}
