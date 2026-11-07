import type { Stage } from '../../shared/schemas/common.js';
import type { Card } from '../../cards/models/card.js';
import type { GateState, ReviewEntry, ReviewGate, ReviewKind } from '../../cards/models/review.js';
import { stripReviewSection } from '../../cards/services/review-log.js';
import type { StageResolution } from '../services/stage-resolver.js';
import type { CardHold } from '../services/next-action.js';
import type { LoopStep } from '../../shared/loop-step.js';
import type { BoardLoop } from '../../shared/loop-activity.js';
import type { TaskProgress } from './plan-state.js';
import type { ForgeConnection, ForgeKind, MrLifecycleState } from './mr-state.js';

// ============================================================
// ボードに表示するカード（3 ソースを束ねた読み取りモデル）
// ============================================================

export interface BoardCardPlan {
  /** ステージ判定には使わず、カード上のプログレスバーとして表示するだけ */
  readonly tasks: TaskProgress;
  readonly archived: boolean;
  /** 計画ファイルの最終更新時刻。「しばらく動きが無い」ことの目安 */
  readonly updatedAt: string;
}

export interface BoardCardMr {
  readonly forge: ForgeKind;
  readonly iid: number;
  readonly state: MrLifecycleState;
  /** Draft か。計画の PR として人に読ませている段階 */
  readonly draft: boolean;
  readonly title: string;
  readonly webUrl: string;
  readonly noteCount: number;
  readonly latestNoteAt: string | null;
  /** AI が人のアカウントで書いた最新のコメントの時刻（Claude Code のフッター付き） */
  readonly latestAiNoteAt: string | null;
  readonly latestCommitAt: string | null;
  /** レビュー指摘のあとに修正コミットが push されたか＝再レビュー待ち */
  readonly resubmitted: boolean;
  /** 人の指摘に AI が応える番か（`awaitsPrFix`）。PR中 のカードを AI の区画へ移し、ループが `fix-pr` で応える */
  readonly awaitingFix: boolean;
  /** マージされた日時。マージされていなければ null */
  readonly mergedAt: string | null;
  /**
   * 最後に Ready にした時刻。作成時から Ready の PR は作成時刻。
   * 今 Draft で一度も Ready にしていなければ null
   */
  readonly readyAt: string | null;
  /** 最後に Draft へ戻された時刻。今 open かつ Draft でなければ null */
  readonly convertedToDraftAt: string | null;
}

/**
 * その列が待っているゲートの最新エントリ（中止を除く）。
 * 計画レビューなら plan。待ちの列でなければゲートを問わず最新を選ぶ。
 *
 * 提出の本文には AI が書いた「判断待ちの点」が入り、時刻は人を待ち始めた時刻になる。
 * 本文の `## レビュー` の解析はボードの導出で済ませ、読む側（`status --json` など）は解析し直さない。
 */
export interface BoardCardReview {
  readonly at: string;
  readonly gate: ReviewGate;
  readonly kind: ReviewKind;
  readonly reason: string;
}

export interface BoardCard {
  readonly id: string;
  readonly title: string;
  readonly created: string;
  readonly stage: Stage;
  readonly reason: string;
  /** 最新のレビューエントリが 中止 か。true なら中止の区画に入る（`groupBySection`） */
  readonly aborted: boolean;
  /** 各ゲートの通過状況 */
  readonly gates: Readonly<Record<ReviewGate, GateState>>;
  /** その列が待っているゲートの最新エントリ（`BoardCardReview`）。無ければ null */
  readonly latestReview: BoardCardReview | null;
  /** 着手を取り消しても残るステージ＝AI の成果物とレビュー記録が課す下限 */
  readonly floorStage: Stage;
  /** 人が「着手」「着手を戻す」で置ける列（今の列も含む）。空なら AI の領分で、人は動かせない */
  readonly droppableStages: readonly Stage[];
  readonly startedAt: string | null;
  readonly skipGates: readonly ReviewGate[];
  readonly branch: string | null;
  readonly mr: number | null;
  /** 並び順。`cards` はこの実効値の順に並んで届く */
  readonly rank: number | null;
  /** `## レビュー` の節を除いた本文。判断は `reviews` で別に返す */
  readonly body: string;
  /**
   * 判断の一覧（`## レビュー` のエントリ）。書かれた順に並ぶ。
   * 理由は組み立てた本文から読むので、理由の中の見出しの行は `####` に下がっている
   */
  readonly reviews: readonly BoardCardReview[];
  /** 計画ファイルがまだ無ければ null */
  readonly plan: BoardCardPlan | null;
  /** PR が未紐付け、または GitHub 未接続なら null */
  readonly mrState: BoardCardMr | null;
  /**
   * AI の列にいるが人の判断を待っているときの止まり（`resolveHold`）。止まっていなければ null。
   * ステージとは別の軸で、どこにも保存しない。ループはこのカードを選ばない
   */
  readonly hold: CardHold | null;
  /**
   * このカードに渡されたループの手（1 手の記録）。開始の時刻の順。
   * ステージの導出にも次の一手にも使わない
   */
  readonly loopSteps: readonly LoopStep[];
}

export interface Board {
  readonly cards: readonly BoardCard[];
  readonly forge: ForgeConnection;
  /**
   * アイデアの表の区切り線の rank。実効値がこれより小さいアイデアが「次にやる」。
   * 一度も動かしていなければ null（すべてのアイデアが「次にやる」）
   */
  readonly ideaDivider: number | null;
  /** ループの様子（今触っている手と、最後に手を終えた時刻）。1 手の記録から組み立てる */
  readonly loop: BoardLoop;
  readonly generatedAt: string;
}

/**
 * Card と導出結果から BoardCard を組み立てる。
 *
 * `entries` は `parseReviewLog(card.body)` の結果。呼び出し側が既に読んでいるので、読み直さずに受け取る。
 * 本文と判断は分けて返し、`body` には `## レビュー` の節を含めない（判断は `reviews` で値のまま読むため）。
 */
export function toBoardCard(
  card: Card,
  entries: readonly ReviewEntry[],
  resolution: StageResolution,
  movement: {
    floorStage: Stage;
    droppableStages: readonly Stage[];
  },
  latestReview: BoardCardReview | null,
  plan: BoardCardPlan | null,
  mrState: BoardCardMr | null,
  hold: CardHold | null,
  loopSteps: readonly LoopStep[]
): BoardCard {
  return {
    id: card.id,
    title: card.title,
    created: card.created,
    stage: resolution.stage,
    reason: resolution.reason,
    aborted: resolution.aborted,
    gates: resolution.gates,
    latestReview,
    floorStage: movement.floorStage,
    droppableStages: movement.droppableStages,
    startedAt: card.startedAt,
    skipGates: card.skipGates,
    branch: card.branch,
    mr: card.mr,
    rank: card.rank,
    body: stripReviewSection(card.body),
    reviews: entries.map(toBoardCardReview),
    plan,
    mrState,
    hold,
    loopSteps,
  };
}

/** 判断のエントリを応答の形にする */
export function toBoardCardReview(entry: ReviewEntry): BoardCardReview {
  return { at: entry.at, gate: entry.gate, kind: entry.kind, reason: entry.reason };
}
