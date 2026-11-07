import type { Card } from '../../cards/models/card.js';
import { gateStates, isAborted, parseReviewLog } from '../../cards/services/review-log.js';
import type { PlanDoc } from '../models/plan-state.js';
import { planReviewable } from './stage-resolver.js';

// ============================================================
// カードのブランチの計画を読むか — ボードの組み立てが git を走らせる前に決める純関数
// ============================================================

/**
 * GitHub が未設定のボードで、カードのブランチの計画（`plans/<id>.md`）を読むなら、そのブランチ名。読まないなら null。
 *
 * 読むのはステージの規則 4（`planReviewable`）に効くカードだけにし、git を走らせる回数を抑える。
 * 中止していない・着手済み・`branch` がある・メインのチェックアウトに計画（`plan`。archive を含む）が無いカード。
 * GitHub が未設定かは呼び出し側が見る。
 */
export function branchPlanTarget(card: Card, plan: PlanDoc | null): string | null {
  if (plan !== null || card.startedAt === null || card.branch === null) return null;

  const entries = parseReviewLog(card.body);
  if (isAborted(entries)) return null;

  return planReviewable(gateStates(entries, card.skipGates).plan) ? card.branch : null;
}
