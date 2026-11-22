import { CardIdSchema, type CardId } from '../../shared/schemas/common.js';
import { isErr, type Result } from '../../shared/result.js';
import { PLAN_FILE_PATTERN, type PlanFileAtRef } from '../../infrastructure/git-plan-tree.js';
import type { PlanDoc, PlanState, TaskProgress } from '../models/plan-state.js';
import {
  COMPLETED_TASK_PATTERN,
  TASK_PATTERN,
  linesOutsideCodeBlocks,
} from '../models/plan-task.js';

// ============================================================
// main の計画の読み取り（read-only）
// ============================================================

/**
 * main（置き場所の参照）の計画ファイルを読む。書き手は AI エージェントで、`ai-board` の CLI は読むだけ。
 *
 * `.ai-board/cards/<card-id>/plan.md` が 1 枚のカードの計画にあたる。計画はカードのブランチに載り、
 * main にはマージでだけ入るので、**main に計画があればマージ済み**とする（`archived` が真）。
 * ディレクトリ名がそのままカード ID なので、紐付けのためのフィールドは要らない。
 *
 * 作業ツリーは読まない。メインのチェックアウトがほかのブランチにいても、そのブランチの計画でマージ済みに見せないため。
 * 計画の成果物（計画レビューを立てるもの）は、Draft の PR と、GitHub が未設定のボードのカードのブランチの計画
 * （`branch-plan.repository.ts`）である。「空ファイルは無視する」といった条件を足さない。
 */
export interface PlanRepository {
  /** 一覧と進捗。本文は返さない。人は計画を PR で読む */
  load(): Promise<PlanState>;
}

/** main の計画ファイルを読む口。読めなければ理由の文 */
export type PlanFileSource = () => Promise<Result<readonly PlanFileAtRef[], string>>;

export class RefPlanRepository implements PlanRepository {
  constructor(private readonly source: PlanFileSource) {}

  async load(): Promise<PlanState> {
    const files = await this.source();
    if (isErr(files)) {
      // 計画が読めなくてもボードは開く。マージ済みは PR がマージされたことでも立つ
      console.warn(`[ai-board] main の計画を読めませんでした: ${files.error}`);
      return new Map();
    }

    const states = new Map<CardId, PlanDoc>();
    for (const file of files.value) {
      const doc = toPlanDoc(file);
      if (doc !== null) states.set(doc.cardId, doc);
    }
    return states;
  }
}

/**
 * 計画ファイル 1 つを読む。ディレクトリ名がカード ID として不正なら警告して読み飛ばす。
 * ここで例外を投げるとボード全体が読めなくなり、置き場所を間違えたファイル 1 つで `status` も `decide` も動かなくなる。
 */
function toPlanDoc(file: PlanFileAtRef): PlanDoc | null {
  const rawId = PLAN_FILE_PATTERN.exec(file.path)?.[1];
  const parsed = CardIdSchema.safeParse(rawId);
  if (!parsed.success) {
    console.warn(
      `[ai-board] 計画ファイルを読み飛ばしました: ${file.path} — ` +
        `ディレクトリ名がカード ID（kebab-case）ではありません`
    );
    return null;
  }
  return {
    cardId: parsed.data as CardId,
    tasks: countTasks(file.content),
    archived: true,
    updatedAt: file.committedAt,
  };
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
