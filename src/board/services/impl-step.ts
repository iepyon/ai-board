import { COMPLETED_TASK_PATTERN, TASK_PATTERN } from '../models/plan-task.js';

// ============================================================
// 実装中の段（implement の手の中の区切り）
// ============================================================

/**
 * `implement` の手で、監視役が次に誰を立てるかを決める段。
 *
 * - `task`: 未チェックのタスクがある（`board-task` に渡す）
 * - `review`: 全部倒れていて、`## AI レビュー` 節が無い（`board-reviewer` に渡す）
 * - `close`: 全部倒れていて `## AI レビュー` 節がある、または計画が archive 済み（`board-worker` に渡す）
 *
 * 段はステージではない。列の導出（`stage-resolver.ts`）には使わない。
 */
export type ImplStep = 'task' | 'review' | 'close';

/** 段の判定の入力。カードのブランチの計画の在りか */
export type ImplStepPlan =
  { readonly location: 'active'; readonly text: string } | { readonly location: 'archived' };

const AI_REVIEW_HEADING = '## AI レビュー';
const CODE_FENCE_PATTERN = /^\s*```/;

/**
 * 計画から段を決める純関数。判定は `board-worker.md` の段の表と同じ順にする。
 *
 * | 計画の状態                                | 段       |
 * | ----------------------------------------- | -------- |
 * | `plans/archive/` にある                   | `close`  |
 * | 未チェックのタスクがある                  | `task`   |
 * | 全部倒れていて、`## AI レビュー` 節が無い | `review` |
 * | 全部倒れていて、`## AI レビュー` 節がある | `close`  |
 *
 * タスクは進捗バーと同じ `TASK_PATTERN` で数え、コードブロックの中の行も数える
 * （進捗バーと食い違わせないため）。タスクが 0 件の計画は「全部倒れている」と扱う。
 * `## AI レビュー` 節は、コードブロックの外にある、行全体がその見出しの行で決める。
 */
export function resolveImplStep(plan: ImplStepPlan): ImplStep {
  if (plan.location === 'archived') {
    return 'close';
  }

  const lines = plan.text.split('\n');
  if (lines.some(isOpenTask)) {
    return 'task';
  }
  return hasAiReviewSection(lines) ? 'close' : 'review';
}

function isOpenTask(line: string): boolean {
  return TASK_PATTERN.test(line) && !COMPLETED_TASK_PATTERN.test(line);
}

function hasAiReviewSection(lines: readonly string[]): boolean {
  let inCodeBlock = false;
  for (const line of lines) {
    if (CODE_FENCE_PATTERN.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (!inCodeBlock && line.trimEnd() === AI_REVIEW_HEADING) {
      return true;
    }
  }
  return false;
}
