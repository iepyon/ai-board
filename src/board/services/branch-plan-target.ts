import type { Card } from '../../cards/models/card.js';
import { gateStates, isAborted, parseReviewLog } from '../../cards/services/review-log.js';
import type { PlanDoc } from '../models/plan-state.js';
import { planReviewable } from './stage-resolver.js';

// ============================================================
// カードのブランチの計画を読むか — ボードの組み立てが git を走らせる前に決める純関数
// ============================================================

/**
 * GitHub が未設定のボードで、カードのブランチの計画（`cards/<id>/plan.md`）を読むなら、そのブランチ名。読まないなら null。
 *
 * 読むのはステージの規則 4（`planReviewable`）に効くカードだけにし、git を走らせる回数を抑える。
 * 中止していない・着手済み・`branch` がある・main に計画（`plan`）が無いカード。
 * GitHub が未設定かは呼び出し側が見る。
 */
export function branchPlanTarget(card: Card, plan: PlanDoc | null): string | null {
  if (plan !== null || card.startedAt === null || card.branch === null) return null;

  const entries = parseReviewLog(card.body);
  if (isAborted(entries)) return null;

  return planReviewable(gateStates(entries, card.skipGates).plan) ? card.branch : null;
}

/**
 * GitHub が未設定のボードで、締めが済んだか（ブランチの計画に `## 締め` の節があるか。`findClosed`）を読むなら、そのブランチ名。読まないなら null。
 *
 * 読むのは実装中の列に効くカード（plan ゲートが `approved`）だけにし、git を走らせる回数を抑える。
 * 中止していない・着手済み・`branch` がある・main に計画（`plan`）が無いカード。
 * main に計画があれば、人がもうマージしている（ステージの規則 1 でマージ済み）。
 * GitHub が未設定かは呼び出し側が見る。
 */
export function branchCloseTarget(card: Card, plan: PlanDoc | null): string | null {
  if (plan !== null || card.startedAt === null || card.branch === null) return null;

  const entries = parseReviewLog(card.body);
  if (isAborted(entries)) return null;

  return gateStates(entries, card.skipGates).plan === 'approved' ? card.branch : null;
}
