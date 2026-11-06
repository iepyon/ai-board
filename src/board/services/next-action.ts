import type { Stage } from '../../shared/schemas/common.js';
import type { GateState, ReviewEntry, ReviewGate } from '../../cards/models/review.js';
import { latestGateEntry } from '../../cards/services/review-log.js';
import type { ImplStep } from './impl-step.js';
import type { ForgeCardFailure } from '../models/mr-state.js';
import type { CardHoldKind } from '../../shared/dashboard-sections.js';

// ============================================================
// 次の一手 — ループが 1 周で進めるものを決める純関数
// ============================================================

/**
 * ループが 1 周で行う作業の種類。
 *
 * - `implement`   実装中。計画の状態から決まる段を進める
 *                 （タスクを倒す段から、AI レビューの後なら締めの段まで続けて進むことがある。レビューの段の前で手を終える。
 *                 締めの段は、動かした証拠を PR の本文に書き、計画を archive して PR を Ready にする）。
 *                 段はここでは分けず、`status` の CLI がカードのブランチの計画を読んで `NextAction.step` に載せる
 *                 （未チェックのタスクがあれば `task` / 倒し終えて `## AI レビュー` 節が無ければ `review` /
 *                 節があるか archive 済みなら `close`。ループは段が `review` なら `board-reviewer` を立て、それ以外は自分で進める）
 * - `plan`        計画提案中で、まだ何も提出していない。計画を書いて Draft の PR を出し、提出する
 * - `revise-plan` 計画提案中で、最新の判断が 否決。理由を読んで計画を直し、再提出する
 * - `fix-pr`      PR中 で、人の指摘に AI が応える番（`awaitsPrFix`）。PR を Ready のまま修正を push するか、
 *                 直すものが無い理由を 1 件返信する。どちらでも人の番（判断待ち）に戻る
 *
 * タスクを倒す / AI レビューを手の種類にしないのは、段が `implement` の中の区切りだからである。
 * 手の種類に足すと、`review-log.ts` / `card-cli.ts` / `dashboard-sections.ts` にまで種類が広がる。
 * 段を読むには計画を読む必要があり、その理由と読む場所は `judgeImpling` を参照。
 *
 * かつては動作確認の否決を直す `revise-impl` と、動作確認の後に Ready にする `ready` があったが、
 * 動作確認の列とともに廃止した（ループの記録に残る過去の手は `loop-step.ts` の `LOOP_PAST_ACTIONS`）。
 */
export type NextActionKind = 'implement' | 'plan' | 'revise-plan' | 'fix-pr';

export interface NextAction {
  readonly cardId: string;
  readonly action: NextActionKind;
  readonly reason: string;
  /**
   * `implement` の手の段（`resolveImplStep`）。`implement` 以外の手では常に null。
   * `pickNextAction` は純関数のまま null を返し、`status` の CLI が `implement` のときだけ
   * カードのブランチの計画を読んで埋める。読めなければ null のまま
   */
  readonly step: ImplStep | null;
}

/**
 * AI の列（計画提案中 / 実装中）にいるが、人の判断を待っているカードの止まり。
 *
 * ステージではない。ステージは「工程のどこにいるか」、止まりは「その工程で誰を待っているか」で、軸が違う。
 * どこにも保存せず、ボードを組み立てるたびに `resolveHold` で導く。
 */
export interface CardHold {
  /** 何を待っているか（`CardHoldKind`） */
  readonly kind: CardHoldKind;
  /** 人が何をすればよいか */
  readonly reason: string;
  /** 人を待ち始めた時刻 */
  readonly since: string;
}

/** 判定に要るフィールドだけ。`BoardCard` が満たす */
export interface NextActionCard {
  readonly id: string;
  readonly stage: Stage;
  readonly aborted: boolean;
  readonly gates: { readonly plan: GateState };
  /** 人の判断を待っていれば、その止まり。`resolveHold` で導く */
  readonly hold: CardHold | null;
  /** PR の状態のうち、人の指摘に AI が応える番か（`awaitsPrFix`）。PR が無ければ null */
  readonly mrState: { readonly awaitingFix: boolean } | null;
}

/** 止まりの判定に要るもの */
export interface HoldInput {
  readonly stage: Stage;
  readonly aborted: boolean;
  readonly gates: { readonly plan: GateState };
  /** カード本文の `## レビュー` のエントリ */
  readonly entries: readonly ReviewEntry[];
  /** PR の状態のうち、Draft に戻されたことの判定に要るもの。PR が無ければ null */
  readonly mr: { readonly iid: number; readonly convertedToDraftAt: string | null } | null;
  /**
   * PR の状態を引けているか（取得先に接続し、初回の取得を終えている）。
   * 偽なら `mr: null` は「PR が無い」ではなく「分からない」なので、成果物が見えないことを止まりにしない
   */
  readonly mrKnown: boolean;
  /**
   * そのカードの PR を直近の取得で引けなかったか（`MrStateProvider.failure`）。引けていれば null。
   * 引けなかったカードの `mr` は前に引けた控えで、古いことがある
   */
  readonly mrFailure: ForgeCardFailure | null;
}

/** 止まりの理由。人が何をすればよいかを書く */
export const HOLD_REASONS = {
  planHeld:
    'AI が計画を直しきれずに止まった。否決の理由を足して直させるか、中止するかを選んでください',
  planLost: '計画を提出済みだが、計画ファイルも Draft の PR も見えない',
  forgeFailed: (message: string): string =>
    `PR の状態を引けない（${message}）。時間を置いても続くなら、GitHub で PR を確かめてください`,
  draftReverted: (iid: number): string =>
    `判断の後に PR #${iid} が Draft に戻された。GitHub で Ready に戻すか、下の判断のボタンで計画から立て直させるか中止してください`,
} as const;

/**
 * 上の列ほど優先する。進んだカードを先に片付け、仕掛かりを増やさない。
 * PR中 は人の列だが、人の指摘に AI が応える番のカードだけを選ぶ（マージに最も近いので最優先）
 */
const PRIORITY: readonly Stage[] = ['pr', 'impling', 'planning'];

/**
 * 次に進めるカードを 1 枚選ぶ。
 *
 * `cards` は `rank` の実効値の順に並んでいる前提で、同じ列の中はその順を保つ。
 * 中止のカード、止まっているカード（`hold`）、人の判断を待つ列（計画レビュー / PR中）は選ばない。
 * ただし PR中 のカードのうち、人の指摘に AI が応える番のものは `fix-pr` で選ぶ。
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
 *   Ready にした PR を人が Draft に戻すとカードは 実装中 に落ち、計画は archive 済みなので、
 *   見ないと `implement` の archive 済みの段が Ready にし直してしまう
 * - **plan 保留**: AI が保留を書いて止まった。同じ手を渡しても AI はまた止まる
 * - **提出済みなのに成果物が見えない**（計画提案中で plan が提出済み）: どちらかがあれば
 *   計画レビュー に上がるはずである。作り直すと PR やブランチを二重に作りかねないので、推測で動かない。
 *   PR の状態を引けていない（`mrKnown` が偽）ときは、PR が無いのか分からないので止まりにしない
 *
 * - **PR の状態を引けない**（アイデア / マージ済み 以外）: そのカードの PR だけを直近の取得で引けなかった（`mrFailure`）。
 *   ほかの止まりより先に見る。前に引けた控えは古いことがあり、人の指摘や Draft への戻しを見落として進めかねないため。
 *   次の取得で引ければひとりでに外れる
 *
 * 人が否決・承認・中止を書けば、そのエントリが最新になって止まりは外れる。
 */
export function resolveHold(card: HoldInput): CardHold | null {
  if (card.aborted) return null;

  if (card.mrFailure !== null && card.stage !== 'idea' && card.stage !== 'merged') {
    return {
      kind: 'forge',
      reason: HOLD_REASONS.forgeFailed(card.mrFailure.message),
      since: card.mrFailure.since,
    };
  }

  switch (card.stage) {
    case 'impling':
      return draftReverted(card);
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
 * 作成時から Draft の PR は `convert_to_draft` を残さないので、実装を進めるあいだの Draft では止まらない。
 * 人の最新の判断は plan の承認（plan を飛ばす宣言のカードなら `plan 提出`）で、それより後に戻された時点で止まる。
 */
function draftReverted(card: HoldInput): CardHold | null {
  const { mr } = card;
  if (mr === null || mr.convertedToDraftAt === null) return null;

  const convertedAt = mr.convertedToDraftAt;
  const latest = latestGateEntry(card.entries);
  if (latest !== null && Date.parse(convertedAt) <= Date.parse(latest.at)) return null;

  return { kind: 'decision', reason: HOLD_REASONS.draftReverted(mr.iid), since: convertedAt };
}

function heldBy(card: HoldInput, gate: ReviewGate, reason: string): CardHold | null {
  return card.gates[gate] === 'held' ? since(card, gate, reason) : null;
}

/** 止まりの起点はそのゲートの最新エントリ（保留や提出）の時刻 */
function since(card: HoldInput, gate: ReviewGate, reason: string): CardHold | null {
  const entry = latestGateEntry(card.entries, gate);
  return entry === null ? null : { kind: 'decision', reason, since: entry.at };
}

function judge(card: NextActionCard): NextAction | null {
  if (card.aborted) return null;

  switch (card.stage) {
    case 'pr':
      return card.mrState?.awaitingFix === true
        ? {
            cardId: card.id,
            action: 'fix-pr',
            reason: 'PR に人の指摘があり、まだ応えていない',
            step: null,
          }
        : null;
    case 'impling':
      return judgeImpling(card);
    case 'planning':
      return judgePlanning(card);
    default:
      return null;
  }
}

/**
 * 実装中のカードの手。止まっていなければ常に `implement` を返す。
 *
 * 計画のタスクの進み具合では分けない。計画ファイルは作業用のブランチにあり、
 * ボードを動かすチェックアウトからは読めないことが多いため。
 * 同じ理由で、タスクを倒す / AI レビュー / 締め（証拠を PR の本文に書き、archive して Ready にする）、の段も手として分けず、
 * `step` は null にする。段は `status` の CLI が、`next` に選ばれた 1 枚のブランチの計画だけを `git show` で読み、
 * `resolveImplStep` で決めて `next.step` に載せる。ここ（とステージの導出）では読まないので、
 * この関数は純関数のままで、「計画ファイルがあれば列が立つ」という読み方とも二重にならない。
 */
function judgeImpling(card: NextActionCard): NextAction {
  return { cardId: card.id, action: 'implement', reason: '計画が承認されている', step: null };
}

function judgePlanning(card: NextActionCard): NextAction | null {
  switch (card.gates.plan) {
    case 'none':
      return {
        cardId: card.id,
        action: 'plan',
        reason: '着手が指示され、計画がまだ無い',
        step: null,
      };
    case 'rejected':
      return { cardId: card.id, action: 'revise-plan', reason: '計画が否決された', step: null };
    case 'submitted':
    case 'held':
      // 止まり（`resolveHold`）として扱い、pickNextAction がここへ来る前に飛ばす
      return null;
    case 'approved':
      // 承認なら 実装中 に上がっているので、ここには来ない
      return null;
  }
}
