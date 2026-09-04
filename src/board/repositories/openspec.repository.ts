import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ChangeName } from '../../shared/schemas/common.js';
import type {
  OpenSpecArtifacts,
  OpenSpecChangeState,
  OpenSpecState,
  TaskProgress,
} from '../models/openspec-state.js';

// ============================================================
// openspec/ の読み取り（read-only）
// ============================================================

/**
 * openspec CLI をサブプロセス起動せず、ディレクトリを直接読む。
 *
 * 理由:
 * - `openspec list --json` は archive を除外するため done 列を作れない
 * - change ごとに `openspec status` を呼ぶと N プロセス起動になる
 * - 完了判定はファイル存在のみで、構造が単純かつ安定している
 * - openspec 未インストールの環境でも動く
 *
 * 判定ロジックは @fission-ai/openspec v1.3.1 の実装に合わせてある。
 */
export interface OpenSpecRepository {
  load(): Promise<OpenSpecState>;
}

const CHANGES_DIR = 'changes';
const ARCHIVE_DIR = 'archive';

/** archive のディレクトリ名に付く日付プレフィックス（core/archive.js:252） */
const ARCHIVE_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

/** utils/task-progress.js の 2 つの正規表現をそのまま移植 */
const TASK_PATTERN = /^[-*]\s+\[[\sx]\]/i;
const COMPLETED_TASK_PATTERN = /^[-*]\s+\[x\]/i;

export class FsOpenSpecRepository implements OpenSpecRepository {
  constructor(private readonly openspecDir: string) {}

  async load(): Promise<OpenSpecState> {
    const changesDir = path.join(this.openspecDir, CHANGES_DIR);
    const archiveDir = path.join(changesDir, ARCHIVE_DIR);

    const [activeNames, archivedDirs] = await Promise.all([
      listDirectories(changesDir, (name) => name !== ARCHIVE_DIR),
      listDirectories(archiveDir),
    ]);

    const states = new Map<string, OpenSpecChangeState>();

    // archive を先に入れる。同名の change が archive と active の両方に
    // 存在する場合（archive 後に同名で作り直したケース）は active を採用する。
    for (const dirName of archivedDirs) {
      const name = stripArchiveDatePrefix(dirName);
      const changeDir = path.join(archiveDir, dirName);
      states.set(name, await readChangeState(name as ChangeName, changeDir, true, dirName));
    }

    for (const name of activeNames) {
      const changeDir = path.join(changesDir, name);
      states.set(name, await readChangeState(name as ChangeName, changeDir, false, null));
    }

    return states;
  }
}

// ============================================================
// パース
// ============================================================

/** `2026-09-01-refresh-token` → `refresh-token` */
export function stripArchiveDatePrefix(dirName: string): string {
  return dirName.replace(ARCHIVE_DATE_PREFIX, '');
}

/** tasks.md のチェックボックスを数える（openspec と同じ数え方） */
export function countTasks(content: string): TaskProgress {
  let total = 0;
  let completed = 0;

  for (const line of content.split('\n')) {
    if (TASK_PATTERN.test(line)) {
      total += 1;
      if (COMPLETED_TASK_PATTERN.test(line)) {
        completed += 1;
      }
    }
  }

  return { completed, total };
}

async function readChangeState(
  name: ChangeName,
  changeDir: string,
  archived: boolean,
  archivedAs: string | null
): Promise<OpenSpecChangeState> {
  const [proposal, design, tasksExists, specs, tasksContent] = await Promise.all([
    isFile(path.join(changeDir, 'proposal.md')),
    isFile(path.join(changeDir, 'design.md')),
    isFile(path.join(changeDir, 'tasks.md')),
    hasMarkdownFile(path.join(changeDir, 'specs')),
    readFileOrNull(path.join(changeDir, 'tasks.md')),
  ]);

  const artifacts: OpenSpecArtifacts = { proposal, specs, design, tasks: tasksExists };

  return {
    name,
    artifacts,
    tasks: tasksContent === null ? { completed: 0, total: 0 } : countTasks(tasksContent),
    archived,
    archivedAs,
  };
}

// ============================================================
// fs ヘルパー
// ============================================================

async function listDirectories(
  dir: string,
  filter: (name: string) => boolean = () => true
): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && filter(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/** specs/**\/*.md に相当。1 つでも見つかった時点で true */
async function hasMarkdownFile(dir: string): Promise<boolean> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      return true;
    }
    if (entry.isDirectory() && (await hasMarkdownFile(path.join(dir, entry.name)))) {
      return true;
    }
  }

  return false;
}
