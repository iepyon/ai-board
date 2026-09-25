import type { CardId } from '../../shared/schemas/common.js';

// ============================================================
// 計画ファイルから読み取った状態
// ============================================================

export interface TaskProgress {
  readonly completed: number;
  readonly total: number;
}

/**
 * `.ai-board/plans/<card-id>.md` 1 ファイルの状態。
 *
 * 計画とタスクを 1 ファイルに持つ。`tasks` はチェックボックスの集計で、
 * カード上のプログレスバーに出るだけでステージ導出の入力には使わない。
 */
export interface PlanDoc {
  readonly cardId: CardId;
  readonly tasks: TaskProgress;
  /** `archive/` 配下へ移動済みか。マージ済みの列を立てる */
  readonly archived: boolean;
}

/** カード ID をキーにした全計画の状態 */
export type PlanState = ReadonlyMap<CardId, PlanDoc>;

/** 本文まで含む 1 件。詳細パネルで人が読むためのもの */
export interface PlanDocument {
  readonly cardId: CardId;
  readonly body: string;
  readonly tasks: TaskProgress;
}
