import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { CardIdSchema, type CardId } from '../../shared/schemas/common.js';
import type { PlanDoc, PlanState, TaskProgress } from '../models/plan-state.js';
import {
  COMPLETED_TASK_PATTERN,
  TASK_PATTERN,
  linesOutsideCodeBlocks,
} from '../models/plan-task.js';

// ============================================================
// .ai-board/plans/ の読み取り（read-only）
// ============================================================

/**
 * 計画ファイルを読む。書き手は AI エージェントで、`ai-board` の CLI は読むだけ。
 *
 * `.ai-board/plans/<card-id>.md` が 1 枚のカードの計画にあたり、
 * `archive/` 配下へ移されたものがマージ済みを表す。
 * ファイル名がそのままカード ID なので、紐付けのためのフィールドは要らない。
 *
 * **計画ファイルが存在するだけで計画レビューの列が立つ。** エージェントが
 * 書き始めた時点で列が動くが、本来のゲートは本文の `## レビュー` に書かれる
 * `plan 提出` であり、ファイルの存在は「ログの欠落で人待ちを取りこぼさない」
 * ための保険である。「空ファイルは無視する」といった条件を足さない。
 */
export interface PlanRepository {
  /** 一覧と進捗。本文は返さない。人は計画を PR で読む */
  load(): Promise<PlanState>;
}

const ARCHIVE_DIR = 'archive';
const PLAN_EXTENSION = '.md';

export class FsPlanRepository implements PlanRepository {
  constructor(private readonly plansDir: string) {}

  async load(): Promise<PlanState> {
    const archiveDir = path.join(this.plansDir, ARCHIVE_DIR);

    const [activeFiles, archivedFiles] = await Promise.all([
      listPlanFiles(this.plansDir),
      listPlanFiles(archiveDir),
    ]);

    const states = new Map<CardId, PlanDoc>();

    // archive を先に入れる。同じカードの計画が archive と直下の両方に
    // 存在する場合（archive 後に作業を再開したケース）は直下を採用する。
    for (const fileName of archivedFiles) {
      const doc = await readPlanDoc(archiveDir, fileName, true);
      if (doc !== null) states.set(doc.cardId, doc);
    }

    for (const fileName of activeFiles) {
      const doc = await readPlanDoc(this.plansDir, fileName, false);
      if (doc !== null) states.set(doc.cardId, doc);
    }

    return states;
  }
}

// ============================================================
// パース
// ============================================================

/**
 * 計画ファイルのチェックボックスを数える。
 *
 * フェンスで囲んだコードブロックの中の行は数えない（計画に書いたチェックボックスの例を
 * タスクとして数えないため。見分け方は `plan-task.ts` の `linesOutsideCodeBlocks`）。
 */
export function countTasks(content: string): TaskProgress {
  let total = 0;
  let completed = 0;

  for (const line of linesOutsideCodeBlocks(content)) {
    if (TASK_PATTERN.test(line)) {
      total += 1;
      if (COMPLETED_TASK_PATTERN.test(line)) {
        completed += 1;
      }
    }
  }

  return { completed, total };
}

/**
 * ファイル名をカード ID として解釈し、1 件を読む。
 *
 * ID として不正な名前のファイルは警告して読み飛ばす。ここで例外を投げると
 * ボード全体が読めなくなり、置き場所を間違えたファイル 1 つで `status` も `decide` も動かなくなる。
 */
async function readPlanDoc(
  dir: string,
  fileName: string,
  archived: boolean
): Promise<PlanDoc | null> {
  const rawId = fileName.slice(0, -PLAN_EXTENSION.length);
  const parsed = CardIdSchema.safeParse(rawId);

  if (!parsed.success) {
    console.warn(
      `[ai-board] 計画ファイルを読み飛ばしました: ${path.join(dir, fileName)} — ` +
        `ファイル名がカード ID（kebab-case）ではありません`
    );
    return null;
  }

  const filePath = path.join(dir, fileName);
  const [content, updatedAt] = await Promise.all([
    readFileOrNull(filePath),
    modifiedAtOrNull(filePath),
  ]);
  if (content === null || updatedAt === null) return null;

  return { cardId: parsed.data as CardId, tasks: countTasks(content), archived, updatedAt };
}

// ============================================================
// fs ヘルパー
// ============================================================

async function listPlanFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(PLAN_EXTENSION))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

async function modifiedAtOrNull(filePath: string): Promise<string | null> {
  try {
    return (await fs.stat(filePath)).mtime.toISOString();
  } catch {
    return null;
  }
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}
