import type { CardId } from '../../shared/schemas/common.js';

// ============================================================
// 計画ファイルから読み取った状態
// ============================================================

export interface TaskProgress {
  readonly completed: number;
  readonly total: number;
}

/**
 * `.ai-board/cards/<card-id>/plan.md` 1 ファイルの状態。
 *
 * 計画とタスクを 1 ファイルに持つ。`tasks` はチェックボックスの集計で、
 * カード上のプログレスバーに出るだけでステージ導出の入力には使わない。
 */
export interface PlanDoc {
  readonly cardId: CardId;
  readonly tasks: TaskProgress;
  /**
   * main（置き場所の参照）に入っているか。真ならマージ済みの列を立てる。
   * 偽はカードのブランチの計画（GitHub が未設定のボードの計画の成果物）。名前は `status --json` の形のために残す
   */
  readonly archived: boolean;
  /**
   * 計画ファイルを最後に変えたコミットの時刻（ISO 8601）。AI がタスクを倒すたびに進むので、
   * 「しばらく動きが無い」ことの目安に使う。ステージ導出には使わない
   */
  readonly updatedAt: string;
}

/** カード ID をキーにした全計画の状態 */
export type PlanState = ReadonlyMap<CardId, PlanDoc>;
