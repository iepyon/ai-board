import type { Stage } from '../../shared/schemas/common.js';
import type { GateState, ReviewEntry, ReviewGate } from '../../cards/models/review.js';
import { latestGateEntry } from '../../cards/services/review-log.js';

// ============================================================
// 次の一手 — ループが 1 周で進めるものを決める純関数
// ============================================================

/**
 * ループが 1 周で行う作業の種類。
 *
 * - `implement`   実装中で、動作確認をまだ頼んでいない。計画の状態から決まる 1 段を進める。
 *                 段は手を受けた `board-worker` がワークツリーの計画を読んで決め、ここでは分けない
 *                 （未チェックのタスクがあれば倒す / 倒し終えて `## AI レビュー` 節が無ければレビューする /
 *                 節があれば動作確認を頼む。verify を飛ばす宣言があれば Ready にする）
 * - `revise-impl` 実装中で、動作確認の最新の判断が 否決。理由を読んで直し、動作確認を頼み直す
 * - `ready`       実装中で、verify ゲートを通った（人の承認、または verify を飛ばすカードの 提出 / 再提出）。
 *                 計画を archive へ移し、PR を Ready にする
 * - `plan`        計画提案中で、まだ何も提出していない。計画を書いて Draft の PR を出し、提出する
 * - `revise-plan` 計画提案中で、最新の判断が 否決。理由を読んで計画を直し、再提出する
 *
 * AI レビューを `review` という手にしないのは、それを選ぶには「タスクを倒し終えたか」と
 * 「`## AI レビュー` 節があるか」を計画から読む必要があるため。理由は `judgeImpling` を参照。
 */
export type NextActionKind = 'implement' | 'revise-impl' | 'ready' | 'plan' | 'revise-plan';

export interface NextAction {
  readonly cardId: string;
  readonly action: NextActionKind;
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
  /** 人の判断を待っていれば、その止まり。`resolveHold` で導く */
  readonly hold: CardHold | null;
}

/** 止まりの判定に要るもの */
export interface HoldInput {
  readonly stage: Stage;
  readonly aborted: boolean;
  readonly gates: { readonly plan: GateState; readonly verify: GateState };
  /** 飛ばす宣言。エントリを選ぶときに、宣言のあるゲートの 提出 / 再提出 を承認と読むのに使う */
  readonly skipGates: readonly ReviewGate[];
  /** カード本文の `## レビュー` のエントリ */
  readonly entries: readonly ReviewEntry[];
  /** PR の状態のうち、Draft に戻されたことの判定に要るもの。PR が無ければ null */
  readonly mr: { readonly iid: number; readonly convertedToDraftAt: string | null } | null;
  /**
   * PR の状態を引けているか（取得先に接続し、初回の取得を終えている）。
   * 偽なら `mr: null` は「PR が無い」ではなく「分からない」なので、成果物が見えないことを止まりにしない
   */
  readonly mrKnown: boolean;
}

/** 止まりの理由。人が何をすればよいかを書く */
export const HOLD_REASONS = {
  verifyHeld:
    'AI が直しきれずに止まった。実装を直させるか、計画から立て直させるか、中止するかを選んでください',
  planHeld:
    'AI が計画を直しきれずに止まった。否決の理由を足して直させるか、中止するかを選んでください',
  planLost: '計画を提出済みだが、計画ファイルも Draft の PR も見えない',
  draftReverted: (iid: number): string =>
    `判断の後に PR #${iid} が Draft に戻された。GitHub で Ready に戻すか、下の判断のボタンで差し戻すか中止してください`,
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
 * AI の列にいるカードが、人の判断を待って止まっているか。止まっていなければ null。
 *
 * - **PR が Draft に戻された**（実装中）: 人の最新の判断より後に PR が Draft に戻された。
 *   動作確認の承認や飛ばす宣言より先に見る。見ないと `ready` や `implement` が Ready にし直してしまう
 * - **verify 保留 / plan 保留**: AI が保留を書いて止まった。同じ手を渡しても AI はまた止まる
 * - **提出済みなのに成果物が見えない**（計画提案中で plan が提出済み）: どちらかがあれば
 *   計画レビュー に上がるはずである。作り直すと PR やブランチを二重に作りかねないので、推測で動かない。
 *   PR の状態を引けていない（`mrKnown` が偽）ときは、PR が無いのか分からないので止まりにしない
 *
 * 人が否決・承認・中止を書けば、そのエントリが最新になって止まりは外れる。
 */
export function resolveHold(card: HoldInput): CardHold | null {
  if (card.aborted) return null;

  switch (card.stage) {
    case 'impling':
      return draftReverted(card) ?? heldBy(card, 'verify', HOLD_REASONS.verifyHeld);
    case 'planning':
      if (card.gates.plan === 'submitted') {
        return card.mrKnown ? since(card, 'plan', HOLD_REASONS.planLost) : null;
      }
      return heldBy(card, 'plan', HOLD_REASONS.planHeld);
    default:
      return null;
  }
}

/**
 * 人の最新の判断より後に PR が Draft に戻されたか。
 *
 * 作成時から Draft の PR は `convert_to_draft` を残さないので、動作確認を頼むあいだの Draft では止まらない。
 * エントリは `latestGateEntry` で選ぶので、宣言のあるゲートの 提出 / 再提出 も承認と同じ区切りになる。
 * plan を飛ばす宣言のカードなら、`plan 提出` より後に戻された時点で止まる。
 */
function draftReverted(card: HoldInput): CardHold | null {
  const { mr } = card;
  if (mr === null || mr.convertedToDraftAt === null) return null;

  const convertedAt = mr.convertedToDraftAt;
  const latest = latestGateEntry(card.entries, undefined, card.skipGates);
  if (latest !== null && Date.parse(convertedAt) <= Date.parse(latest.at)) return null;

  return { reason: HOLD_REASONS.draftReverted(mr.iid), since: convertedAt };
}

function heldBy(card: HoldInput, gate: ReviewGate, reason: string): CardHold | null {
  return card.gates[gate] === 'held' ? since(card, gate, reason) : null;
}

/** 止まりの起点はそのゲートの最新エントリ（保留や提出）の時刻 */
function since(card: HoldInput, gate: ReviewGate, reason: string): CardHold | null {
  const entry = latestGateEntry(card.entries, gate, card.skipGates);
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
 * 同じ理由で、タスクを倒す / AI レビュー / 動作確認を頼む、の段も手として分けず、どれも `implement` を返す。
 * 段は手を受けた `board-worker` がワークツリーの計画（未チェックのタスクと `## AI レビュー` 節の有無）から決める。
 * ここでブランチの計画を `git show` で読む案は、サーバと `status` に git の読み取りを持ち込み、
 * 「計画ファイルがあれば列が立つ」という読み方とも二重になるので採らない。
 *
 * verify の approved は、人の承認でも、verify を飛ばす宣言のカードの AI の `verify 提出 / 再提出` の
 * 読み替え（`gateState`）でも、同じく `ready` を返す。宣言のあるカードの approved は、動作確認で否決された実装を
 * `revise-impl` が直して再提出した後か、提出の後に人が宣言を入れた後に来る。どちらも AI レビューと
 * PR の本文の見送りの節を済ませているので、締めの段（見送りの節を計画から差し替え、判断してほしい点を
 * PR にコメントする）を通さずに、archive して Ready にするだけにする。
 * 締めの段を通すと、`revise-impl` が PR の本文に足した見送りが消え、計画の判断してほしい点のコメントが重なる。
 */
function judgeImpling(card: NextActionCard): NextAction | null {
  switch (card.gates.verify) {
    case 'none':
      return { cardId: card.id, action: 'implement', reason: '計画が承認されている' };
    case 'rejected':
      return { cardId: card.id, action: 'revise-impl', reason: '動作確認で否決された' };
    case 'approved':
      return { cardId: card.id, action: 'ready', reason: '動作確認が承認された' };
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
