import { ok, type Result } from '../../../shared/result.js';
import type { RecordChangesError } from '../../errors/card-errors.js';
import { diffSnapshots } from '../../services/board-changes.js';
import { loadChangeFiles, loadDbSnapshot, type ChangeRepositories } from './change-state.js';

// ============================================================
// 変更の書き出しユースケース（`ai-board changes`）
// ============================================================

export interface RecordedChanges {
  /** 書き出したファイル名。差分が無ければ null（ファイルを作らない） */
  readonly name: string | null;
  /** 書き出した操作の数 */
  readonly opCount: number;
  /** 適用済みの記録はあるが手元に無いファイル */
  readonly missing: readonly string[];
}

export type RecordChangesCommand = (
  now: Date
) => Promise<Result<RecordedChanges, RecordChangesError>>;

/**
 * DB のうち、まだ変更ファイルに書き出していない変更を 1 つの新しいファイルに書く。
 *
 * 基準の状態は別に記録せず、適用済みのファイルを流し直して作る。
 * 書いたファイルは DB に反映済みなので、適用済みとして記録する。
 */
export function createRecordChangesCommand(repositories: ChangeRepositories): RecordChangesCommand {
  return async (now) => {
    const state = await loadChangeFiles(repositories);
    if (!state.ok) return state;

    const { recorded, missing } = state.value;
    const ops = diffSnapshots(recorded, await loadDbSnapshot(repositories));

    if (ops.length === 0) {
      return ok({ name: null, opCount: 0, missing });
    }

    const name = await repositories.files.write(ops, now);
    await repositories.applied.record([name], now);

    return ok({ name, opCount: ops.length, missing });
  };
}
