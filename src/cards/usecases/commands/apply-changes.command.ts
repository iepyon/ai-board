import { err, ok, type Result } from '../../../shared/result.js';
import type { BoardSnapshot, ChangeOp } from '../../models/change.js';
import type { ApplyChangesError } from '../../errors/card-errors.js';
import { describeDiff, diffSnapshots, replay } from '../../services/board-changes.js';
import { loadChangeFiles, loadDbSnapshot, type ChangeRepositories } from './change-state.js';

// ============================================================
// 未適用の変更ファイルの適用ユースケース
// ============================================================

export interface AppliedChanges {
  /** 今回適用したファイル名（名前の順） */
  readonly applied: readonly string[];
  /** 適用済みの記録はあるが手元に無いファイル */
  readonly missing: readonly string[];
}

export type ApplyChangesCommand = (now: Date) => Promise<Result<AppliedChanges, ApplyChangesError>>;

/**
 * まだ適用していない変更ファイルを DB に反映する。DB を開くたび（サーバの起動、CLI）に呼ぶ。
 *
 * DB に書き出していない変更があれば、何もせず `UnrecordedChanges` を返す。
 * そのまま進めると手元の変更を上書きするため。
 *
 * 反映は未適用のファイルを足していくのではなく、DB を「全ファイルを名前の順に流し直した状態」に揃える。
 * 同じ列を複数のファイルが書いたとき、どの DB でも名前の順で後のものが勝つようにするため。
 */
export function createApplyChangesCommand(repositories: ChangeRepositories): ApplyChangesCommand {
  return async (now) => {
    const state = await loadChangeFiles(repositories);
    if (!state.ok) return state;

    const { files, applied, missing, recorded } = state.value;
    const pending = files.map((file) => file.name).filter((name) => !applied.has(name));

    if (pending.length === 0) {
      return ok({ applied: [], missing });
    }

    const current = await loadDbSnapshot(repositories);
    const unrecorded = diffSnapshots(recorded, current);
    if (unrecorded.length > 0) {
      return err({ type: 'UnrecordedChanges', ...describeDiff(unrecorded) });
    }

    const target = replay(files);
    if (!target.ok) return target;

    const ops = diffSnapshots(current, target.value);

    await repositories.applied.transaction(async () => {
      await writeOps(repositories, current, target.value, ops);
      await repositories.applied.record(pending, now);
    });

    return ok({ applied: pending, missing });
  };
}

/** 差分の操作が指すカードと区切り線を、目標の状態の値で DB に書く */
async function writeOps(
  repositories: ChangeRepositories,
  current: BoardSnapshot,
  target: BoardSnapshot,
  ops: readonly ChangeOp[]
): Promise<void> {
  for (const op of ops) {
    if (op.kind === 'divider') {
      await repositories.divider.set(op.rank);
      continue;
    }

    const card = target.cards.get(op.id);
    if (card === undefined) continue;

    if (current.cards.has(op.id)) {
      await repositories.cards.save(card);
    } else {
      await repositories.cards.create(card);
    }
  }
}
