import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { CardIdSchema, type CardId } from '../../shared/schemas/common.js';
import type { PlanDoc, PlanState, TaskProgress } from '../models/plan-state.js';

// ============================================================
// .ai-board/plans/ の読み取り（read-only）
// ============================================================

/**
 * 計画ファイルを読む。書き手は AI エージェントで、サーバは触らない。
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
  /** 一覧と進捗。本文は返さない（ボードのレスポンスに載せると肥大するため） */
  load(): Promise<PlanState>;
  /** 1 件の本文。無ければ null */
  readBody(id: CardId): Promise<string | null>;
}

const ARCHIVE_DIR = 'archive';
const PLAN_EXTENSION = '.md';

/**
 * タスクのチェックボックス行。
 *
 * 先頭の空白を許すのは、インデントされたサブタスクを親と同じように数えるため
 * （列 0 に固定すると `  - [ ] 1.1.1 …` が進捗から消える）。
 * 箇条点とブラケットの間も `\s*` で、`-[ ]` のような詰めた書き方も拾う。
 * 狭めると数えていた行が落ちるだけなので、意図的に緩くしてある。
 */
const TASK_PATTERN = /^\s*[-*]\s*\[[\sx]\]/i;
const COMPLETED_TASK_PATTERN = /^\s*[-*]\s*\[x\]/i;

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

  async readBody(id: CardId): Promise<string | null> {
    // path は検証済みの ID からしか組み立てない。カードの ID は人もエージェントも
    // 書ける場所なので、パストラバーサルの判断をここに閉じる。
    const fileName = `${id}${PLAN_EXTENSION}`;

    return (
      (await readFileOrNull(path.join(this.plansDir, fileName))) ??
      (await readFileOrNull(path.join(this.plansDir, ARCHIVE_DIR, fileName)))
    );
  }
}

// ============================================================
// パース
// ============================================================

/** 計画ファイルのチェックボックスを数える */
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

/**
 * ファイル名をカード ID として解釈し、1 件を読む。
 *
 * ID として不正な名前のファイルは警告して読み飛ばす。ここで例外を投げると
 * ボード全体が 500 になり、置き場所を間違えたファイル 1 つで画面が死ぬ。
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
