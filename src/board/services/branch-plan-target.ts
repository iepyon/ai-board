import type { Card } from '../../cards/models/card.js';
import { gateStates, isAborted, parseReviewLog } from '../../cards/services/review-log.js';
import { isForgeUnset, type ForgeConnection } from '../models/mr-state.js';
import type { PlanDoc } from '../models/plan-state.js';

// ============================================================
// カードのブランチの計画を読むか — ボードの組み立てが git を走らせる前に決める純関数
// ============================================================

export interface BranchPlanTargetInput {
  readonly forge: ForgeConnection;
  readonly card: Card;
  /** メインのチェックアウトの計画（`archive/` を含む）。無ければ null */
  readonly plan: PlanDoc | null;
}

/**
 * カードのブランチの計画（`plans/<id>.md`）を読んで、メインの計画の代わりにするか。
 *
 * GitHub が未設定（`isForgeUnset`）のボードには Draft の PR が無いので、ブランチの計画で計画レビューの列を立てる。
 * 読むのはステージの規則 4（計画ファイルがあり plan ゲートが none / submitted）に効くカードだけにし、git を走らせる回数を抑える。
 *
 * - 中止していない・着手済み・`branch` がある
 * - メインのチェックアウトに計画が無い（あればそちらを使う）
 * - plan ゲートが none か submitted（承認済みは規則 3、差し戻し・保留は計画提案中で、計画の有無に依らない）
 */
export function needsBranchPlan({ forge, card, plan }: BranchPlanTargetInput): boolean {
  if (!isForgeUnset(forge) || plan !== null) return false;
  if (card.startedAt === null || card.branch === null) return false;

  const entries = parseReviewLog(card.body);
  if (isAborted(entries)) return false;

  const gate = gateStates(entries, card.skipGates).plan;
  return gate === 'none' || gate === 'submitted';
}
