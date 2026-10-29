// ============================================================
// API レスポンスの型（サーバの BoardCard と対応）
// ============================================================

export type Stage = 'idea' | 'planning' | 'plan-review' | 'impling' | 'verifying' | 'pr' | 'merged';

/** 人が判断するゲートのうち、レビューログに現れるもの */
export type ReviewGate = 'plan' | 'verify';

export type ReviewKind = '提出' | '再提出' | '承認' | '否決' | '中止';

export type GateState = 'none' | 'submitted' | 'approved' | 'rejected';

export interface BoardCardPlan {
  tasks: { completed: number; total: number };
  archived: boolean;
  /** 計画ファイルの最終更新時刻。「しばらく動きが無い」ことの目安 */
  updatedAt: string;
}

/**
 * その列が待っているゲートの最新エントリ（中止を除く）。提出の本文が判断待ちの点になる。
 * 待ちの列でなければゲートを問わず最新
 */
export interface BoardCardReview {
  at: string;
  gate: ReviewGate;
  kind: ReviewKind;
  reason: string;
}

export interface BoardCardMr {
  forge: ForgeKind;
  iid: number;
  state: 'opened' | 'closed' | 'locked' | 'merged';
  /** Draft か。計画の PR として人に読ませている段階 */
  draft: boolean;
  title: string;
  webUrl: string;
  noteCount: number;
  latestNoteAt: string | null;
  latestCommitAt: string | null;
  /** レビュー指摘のあとに修正コミットが push されたか＝再レビュー待ち */
  resubmitted: boolean;
  /** マージされた日時。マージされていなければ null */
  mergedAt: string | null;
}

export interface BoardCard {
  id: string;
  title: string;
  created: string;
  stage: Stage;
  reason: string;
  /** 最新のレビューエントリが 中止 か */
  aborted: boolean;
  gates: Record<ReviewGate, GateState>;
  latestReview: BoardCardReview | null;
  /** 着手を取り消しても残るステージ＝AI の成果物とレビュー記録が課す下限 */
  floorStage: Stage;
  /** 人が「着手」「着手を戻す」で置ける列（今の列も含む）。空なら AI の領分で、人は動かせない */
  droppableStages: Stage[];
  startedAt: string | null;
  skipGates: ReviewGate[];
  branch: string | null;
  mr: number | null;
  /** 並び順。`cards` はこの順に並んで届くので、画面は受け取った順に出せばよい */
  rank: number | null;
  body: string;
  plan: BoardCardPlan | null;
  mrState: BoardCardMr | null;
}

export type ForgeKind = 'github';

export type ForgeConnection =
  | { status: 'disabled'; kind: ForgeKind | null; reason: string | null }
  | { status: 'connected'; kind: ForgeKind }
  | { status: 'error'; kind: ForgeKind; message: string };

export interface Board {
  stages: Stage[];
  cards: BoardCard[];
  forge: ForgeConnection;
  orphanPlans: string[];
  /** アイデアの表の区切り線の rank。未設定なら null（すべて「次にやる」） */
  ideaDivider: number | null;
  generatedAt: string;
}

/**
 * 人が直接動かせるステージ（「着手」「着手を戻す」のボタン）。
 * 残りは AI の成果物か、レビューボタンの追記で決まる。
 */
export const HUMAN_STAGES: Stage[] = ['idea', 'planning'];

export function isHumanStage(stage: Stage): boolean {
  return HUMAN_STAGES.includes(stage);
}

export { STAGE_LABELS } from '../shared/stage-labels.js';

/** その列で次に動くのは誰か。見出しのアイコンに使う */
export const STAGE_OWNER: Record<Stage, 'human' | 'ai' | 'none'> = {
  idea: 'human',
  planning: 'ai',
  'plan-review': 'human',
  impling: 'ai',
  verifying: 'human',
  pr: 'human',
  merged: 'none',
};

/** 列の帯色 = そのステージを立てる情報源 */
export const STAGE_SOURCE: Record<Stage, 'card' | 'plan' | 'forge' | 'archive'> = {
  idea: 'card',
  planning: 'card',
  'plan-review': 'plan',
  impling: 'plan',
  verifying: 'plan',
  pr: 'forge',
  merged: 'archive',
};

export { GATE_OF_STAGE } from '../shared/stage-gates.js';

/**
 * 人の判断を待つ列。札と件数帯に ★ を付ける。
 *
 * 計画レビュー / 動作確認 はボタンで、PR中 は GitHub でマージして判断する。
 * ボタンを出す列（`GATE_OF_STAGE`）より 1 つ広い。
 */
export const GATE_STAGES: readonly Stage[] = ['plan-review', 'verifying', 'pr'];
