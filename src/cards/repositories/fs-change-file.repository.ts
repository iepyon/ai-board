import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { err, ok, type Result } from '../../shared/result.js';
import type { CardId } from '../../shared/schemas/common.js';
import type { CardFieldChanges, ChangeFile, ChangeOp } from '../models/change.js';
import { ChangeFileSchema, type ChangeFileContent } from '../models/schemas/change.schema.js';
import type { ChangeFileMalformed } from '../errors/card-errors.js';
import { compareNames } from '../services/board-changes.js';
import type { ChangeFileRepository } from './change-file.repository.js';

// ============================================================
// ファイルシステムによる変更ファイルのリポジトリ実装
// ============================================================

const EXTENSION = '.yaml';

export class FsChangeFileRepository implements ChangeFileRepository {
  constructor(private readonly dir: string) {}

  async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(EXTENSION))
        .map((entry) => entry.name)
        .sort(compareNames);
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  async read(name: string): Promise<Result<ChangeFile, ChangeFileMalformed>> {
    const malformed = (reason: string): Result<ChangeFile, ChangeFileMalformed> =>
      err({ type: 'ChangeFileMalformed', file: name, reason });

    let raw: unknown;
    try {
      raw = parseYaml(await fs.readFile(path.join(this.dir, name), 'utf-8'));
    } catch (error) {
      return malformed(error instanceof Error ? error.message : String(error));
    }

    const result = ChangeFileSchema.safeParse(raw ?? []);
    if (!result.success) {
      return malformed(
        result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ')
      );
    }

    return ok({ name, ops: result.data.map(toOp) });
  }

  async write(ops: readonly ChangeOp[], now: Date): Promise<string> {
    const name = `${timestamp(now)}-${randomBytes(2).toString('hex')}${EXTENSION}`;
    const content = ops.map(toContent);

    await fs.mkdir(this.dir, { recursive: true });
    // 既存のファイルは書き換えない（名前がぶつかったら失敗させる）
    await fs.writeFile(path.join(this.dir, name), stringifyYaml(content, { lineWidth: 0 }), {
      flag: 'wx',
    });

    return name;
  }
}

// ============================================================
// ファイルの中身 ⇄ 操作
// ============================================================

function toOp(entry: ChangeFileContent[number]): ChangeOp {
  if ('divider' in entry) {
    return { kind: 'divider', rank: entry.divider };
  }
  return { kind: 'card', id: entry.card as CardId, set: entry.set as CardFieldChanges };
}

/** 読み込み（`ChangeFileSchema`）と同じ形に書く */
function toContent(op: ChangeOp): Record<string, unknown> {
  return op.kind === 'divider' ? { divider: op.rank } : { card: op.id, set: op.set };
}

/** `2026-09-27T07:15:00.123Z` → `20260927T071500123Z`。名前の順が時刻の順になる */
function timestamp(now: Date): string {
  return now.toISOString().replace(/[-:.]/g, '');
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
