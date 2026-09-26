// ============================================================
// API レスポンスの型（サーバの BoardCard と対応）
// ============================================================

export type Stage = 'idea' | 'planning' | 'plan-review' | 'impling' | 'pr' | 'merged';

/** 人が判断するゲートのうち、レビューログに現れるもの */
export type ReviewGate = 'plan';

export type ReviewKind = '提出' | '再提出' | '承認' | '否決' | '中止';

export type GateState = 'none' | 'submitted' | 'approved' | 'rejected';

export interface BoardCardPlan {
  tasks: { completed: number; total: number };
  archived: boolean;
  /** 計画ファイルの最終更新時刻。「しばらく動きが無い」ことの目安 */
  updatedAt: string;
}

/** plan ゲートの最新エントリ（中止を除く）。提出の本文が判断待ちの点になる */
export interface BoardCardReview {
  at: string;
  kind: ReviewKind;
  reason: string;
}

/** `GET /api/plans/:id` のレスポンス。本文はボードには載らない */
export interface PlanDocument {
  id: string;
  body: string;
  tasks: { completed: number; total: number };
}

export interface BoardCardMr {
  forge: ForgeKind;
  iid: number;
  state: 'opened' | 'closed' | 'locked' | 'merged';
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
  /** 人が手でドロップできる列。空なら AI の領分でドラッグ不可 */
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
 * 人が直接ドラッグで動かせるステージ。
 * 残りは AI の成果物か、レビューボタンの追記で決まる。
 */
export const HUMAN_STAGES: Stage[] = ['idea', 'planning'];

export function isHumanStage(stage: Stage): boolean {
  return HUMAN_STAGES.includes(stage);
}

/** 列見出しに出す日本語ラベル */
export const STAGE_LABELS: Record<Stage, string> = {
  idea: 'アイデア',
  planning: '計画提案中',
  'plan-review': '計画レビュー',
  impling: '実装中',
  pr: 'PR中',
  merged: 'マージ済み',
};

/** その列で次に動くのは誰か。見出しのアイコンに使う */
export const STAGE_OWNER: Record<Stage, 'human' | 'ai' | 'none'> = {
  idea: 'human',
  planning: 'ai',
  'plan-review': 'human',
  impling: 'ai',
  pr: 'human',
  merged: 'none',
};

/** 列の帯色 = そのステージを立てる情報源 */
export const STAGE_SOURCE: Record<Stage, 'card' | 'plan' | 'forge' | 'archive'> = {
  idea: 'card',
  planning: 'card',
  'plan-review': 'plan',
  impling: 'plan',
  pr: 'forge',
  merged: 'archive',
};

/** その列が人の判断を待っているゲート。待ちの列でなければ undefined */
export const GATE_OF_STAGE: Partial<Record<Stage, ReviewGate>> = {
  'plan-review': 'plan',
};
