import type { Result } from '../../shared/result.js';
import type { ChangeFile, ChangeOp } from '../models/change.js';
import type { ChangeFileMalformed } from '../errors/card-errors.js';

// ============================================================
// 変更ファイル（`.ai-board/changes/*.yaml`）のリポジトリのインターフェース
// ============================================================

/**
 * データのマイグレーションのファイルを読み書きする。ファイルは git に載せ、ブランチのマージでまとめる。
 * 1 回の書き出しで 1 ファイルを足し、既存のファイルは書き換えない（マージで衝突させないため）。
 */
export interface ChangeFileRepository {
  /** ファイル名を適用の順（名前の順）で返す。置き場所が無ければ空 */
  list(): Promise<string[]>;
  read(name: string): Promise<Result<ChangeFile, ChangeFileMalformed>>;
  /** 新しいファイルを書き、その名前を返す */
  write(ops: readonly ChangeOp[], now: Date): Promise<string>;
}
