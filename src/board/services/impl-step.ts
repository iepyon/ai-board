import {
  COMPLETED_TASK_PATTERN,
  TASK_PATTERN,
  linesOutsideCodeBlocks,
} from '../models/plan-task.js';

// ============================================================
// 実装中の段（implement の手の中の区切り）
// ============================================================

/**
 * `implement` の手で、ループが自分で進めるか `board-reviewer` を立てるかを決める段。
 *
 * - `task`: 未チェックのタスクがある（本筋のセッションが `implement.md` で進める）
 * - `review`: 全部倒れていて、`## AI レビュー` 節が無い（`board-reviewer` のサブエージェントを立てる）
 * - `close`: 全部倒れていて `## AI レビュー` 節がある、または計画が archive 済み（本筋のセッションが `implement.md` で進める）
 *
 * 段はステージではない。列の導出（`stage-resolver.ts`）には使わない。
 */
export type ImplStep = 'task' | 'review' | 'close';

/** 段の判定の入力。カードのブランチの計画の在りか */
export type ImplStepPlan =
  { readonly location: 'active'; readonly text: string } | { readonly location: 'archived' };

const AI_REVIEW_HEADING = '## AI レビュー';

/**
 * 計画から段を決める純関数。判定は `.claude/skills/board-loop/implement.md` の段の表と同じ順にする。
 *
 * | 計画の状態                                | 段       |
 * | ----------------------------------------- | -------- |
 * | `plans/archive/` にある                   | `close`  |
 * | 未チェックのタスクがある                  | `task`   |
 * | 全部倒れていて、`## AI レビュー` 節が無い | `review` |
 * | 全部倒れていて、`## AI レビュー` 節がある | `close`  |
 *
 * タスクは進捗バー（`plan.repository.ts` の `countTasks`）と同じく、`linesOutsideCodeBlocks` で
 * フェンスで囲んだコードブロックの中の行を外してから `TASK_PATTERN` で数える
 * （計画に書いたチェックボックスの例をタスクと数えないため。見分け方は `plan-task.ts`）。
 * タスクが 0 件の計画は「全部倒れている」と扱う。
 * `## AI レビュー` 節も、同じくコードブロックの外にある、行全体がその見出しの行で決める。
 */
export function resolveImplStep(plan: ImplStepPlan): ImplStep {
  if (plan.location === 'archived') {
    return 'close';
  }

  const lines = linesOutsideCodeBlocks(plan.text);
  if (lines.some(isOpenTask)) {
    return 'task';
  }
  return hasAiReviewSection(lines) ? 'close' : 'review';
}

function isOpenTask(line: string): boolean {
  return TASK_PATTERN.test(line) && !COMPLETED_TASK_PATTERN.test(line);
}

function hasAiReviewSection(lines: readonly string[]): boolean {
  return lines.some((line) => line.trimEnd() === AI_REVIEW_HEADING);
}
