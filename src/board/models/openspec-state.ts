import type { ChangeName } from '../../shared/schemas/common.js';

// ============================================================
// openspec ディレクトリから読み取った状態
// ============================================================

/**
 * openspec の spec-driven スキーマが定義する 4 つの artifact。
 * 完了判定はファイルの存在のみ（openspec 本体の実装と同じ）。
 */
export interface OpenSpecArtifacts {
  readonly proposal: boolean;
  readonly specs: boolean;
  readonly design: boolean;
  readonly tasks: boolean;
}

export interface TaskProgress {
  readonly completed: number;
  readonly total: number;
}

export interface OpenSpecChangeState {
  readonly name: ChangeName;
  readonly artifacts: OpenSpecArtifacts;
  readonly tasks: TaskProgress;
  /** archive/ 配下に移動済みか */
  readonly archived: boolean;
  /** archive のディレクトリ名（`YYYY-MM-DD-<change>`）。未 archive なら null */
  readonly archivedAs: string | null;
}

/** change 名をキーにした全 change の状態 */
export type OpenSpecState = ReadonlyMap<string, OpenSpecChangeState>;
