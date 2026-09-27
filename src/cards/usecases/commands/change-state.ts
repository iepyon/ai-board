import { err, ok, type Result } from '../../../shared/result.js';
import type { BoardSnapshot, ChangeFile } from '../../models/change.js';
import type { ChangeFileMalformed } from '../../errors/card-errors.js';
import type { CardRepository } from '../../repositories/card.repository.js';
import type { IdeaDividerRepository } from '../../repositories/idea-divider.repository.js';
import type { ChangeFileRepository } from '../../repositories/change-file.repository.js';
import type { AppliedChangeRepository } from '../../repositories/applied-change.repository.js';
import { replay } from '../../services/board-changes.js';

// ============================================================
// データのマイグレーションの書き出し・適用に共通する読み込み
// ============================================================

export interface ChangeRepositories {
  readonly cards: CardRepository;
  readonly divider: IdeaDividerRepository;
  readonly files: ChangeFileRepository;
  readonly applied: AppliedChangeRepository;
}

/** 変更ファイルと適用済みの記録を突き合わせた結果 */
export interface ChangeFilesState {
  /** 手元にある全ファイル（名前の順） */
  readonly files: readonly ChangeFile[];
  /** 適用済みの記録があるファイル名 */
  readonly applied: ReadonlySet<string>;
  /** 適用済みの記録はあるが手元に無いファイル（ブランチの切り替えなどで消えた） */
  readonly missing: readonly string[];
  /** 適用済みで手元にあるファイルを流し直した状態＝ファイルとして書き出し済みの状態 */
  readonly recorded: BoardSnapshot;
}

export async function loadChangeFiles(
  repositories: ChangeRepositories
): Promise<Result<ChangeFilesState, ChangeFileMalformed>> {
  const names = await repositories.files.list();
  const applied = await repositories.applied.names();

  const files: ChangeFile[] = [];
  for (const name of names) {
    const file = await repositories.files.read(name);
    if (!file.ok) return file;
    files.push(file.value);
  }

  const present = new Set(names);
  const recorded = replay(files.filter((file) => applied.has(file.name)));
  if (!recorded.ok) return err(recorded.error);

  return ok({
    files,
    applied,
    missing: [...applied].filter((name) => !present.has(name)).sort(),
    recorded: recorded.value,
  });
}

/** 今の DB の状態 */
export async function loadDbSnapshot(repositories: ChangeRepositories): Promise<BoardSnapshot> {
  const cards = await repositories.cards.findAll();

  return {
    cards: new Map(cards.map((card) => [card.id, card])),
    divider: await repositories.divider.get(),
  };
}
