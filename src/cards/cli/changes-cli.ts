import type { ChangeDependencies } from '../composition.js';
import type { ApplyChangesError } from '../errors/card-errors.js';

// ============================================================
// ai-board changes — カードの変更をデータのマイグレーションとして書き出す
// ============================================================

export interface ChangesIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now: () => Date;
}

/**
 * `ai-board changes`。書き出していない変更を 1 つのファイルに書いてから、未適用のファイルを適用する。
 *
 * 書き出しを先にするので、手元の変更は新しい名前のファイルになり、
 * マージで入ってきた古い名前のファイルより後に流れる（同じ列なら手元の変更が勝つ）。
 */
export async function runChangesCli(deps: ChangeDependencies, io: ChangesIo): Promise<number> {
  const recorded = await deps.recordChangesCommand(io.now());
  if (!recorded.ok) {
    io.stderr(`${describeApplyError(recorded.error)}\n`);
    return 1;
  }

  const { name, opCount, missing } = recorded.value;
  warnMissing(missing, io.stderr);
  io.stdout(
    name === null
      ? '書き出す変更はありません\n'
      : `変更を書き出しました: .ai-board/changes/${name}（${opCount} 件の操作）\n`
  );

  return (await applyChanges(deps, io)) ? 0 : 1;
}

/**
 * 未適用の変更ファイルを適用し、結果を知らせる。DB を開いたときに毎回呼ぶ。
 * 適用できなくても、呼び出し側の処理（サーバの起動や `ai-board card`）は止めない。
 */
export async function applyChanges(
  deps: ChangeDependencies,
  io: Pick<ChangesIo, 'stderr' | 'now'>
): Promise<boolean> {
  let result: Awaited<ReturnType<ChangeDependencies['applyChangesCommand']>>;
  try {
    result = await deps.applyChangesCommand(io.now());
  } catch (error) {
    // 別のプロセスが DB をロックし続けている、置き場所を読めない、など。ロールバック済み
    const reason = error instanceof Error ? error.message : String(error);
    io.stderr(`[ai-board] 変更ファイルを適用できませんでした: ${reason}\n`);
    return false;
  }

  if (!result.ok) {
    io.stderr(`${describeApplyError(result.error)}\n`);
    return false;
  }

  const { applied, missing } = result.value;
  warnMissing(missing, io.stderr);
  if (applied.length > 0) {
    io.stderr(`[ai-board] 変更ファイルを ${applied.length} 件適用しました\n`);
  }
  return true;
}

export function describeApplyError(error: ApplyChangesError): string {
  switch (error.type) {
    case 'ChangeFileMalformed':
      return `[ai-board] 変更ファイルを読めないため、適用をやめました: .ai-board/changes/${error.file} — ${error.reason}`;
    case 'UnrecordedChanges': {
      const targets = [...error.cardIds, ...(error.divider ? ['アイデアの区切り線'] : [])];
      return (
        `[ai-board] DB に書き出していない変更があるため、変更ファイルを適用しませんでした（${targets.join(', ')}）。` +
        '先に ai-board changes を実行してください'
      );
    }
  }
}

function warnMissing(missing: readonly string[], stderr: (text: string) => void): void {
  if (missing.length > 0) {
    stderr(`[ai-board] 適用済みの変更ファイルが手元にありません: ${missing.join(', ')}\n`);
  }
}
