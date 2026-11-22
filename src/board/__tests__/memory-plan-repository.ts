import { ok } from '../../shared/result.js';
import type { CardId } from '../../shared/schemas/common.js';
import {
  RefPlanRepository,
  countTasks,
  type PlanRepository,
} from '../repositories/plan.repository.js';
import type { PlanDoc, PlanState } from '../models/plan-state.js';

// ============================================================
// テストの計画 — 計画の成果物（archived: false）と main に入った計画（archived: true）を直接置く
// ============================================================

/**
 * 計画のリポジトリの口を、テストで置いた計画で満たす。
 *
 * 本物の main の計画（`RefPlanRepository`）は、main に入った計画（マージ済み）だけを返す。
 * 計画の成果物（Draft の PR・GitHub が未設定のボードのブランチの計画）として計画レビューを立てる場面は、
 * `archived: false` の計画を置いて表す。`archive/<id>` の名前で置けば、main に入った計画にする。
 */
export class MemoryPlanRepository implements PlanRepository {
  private readonly docs = new Map<CardId, PlanDoc>();

  set(name: string, content: string, updatedAt = new Date().toISOString()): void {
    const archived = name.startsWith('archive/');
    const cardId = (archived ? name.slice('archive/'.length) : name) as CardId;
    this.docs.set(cardId, { cardId, tasks: countTasks(content), archived, updatedAt });
  }

  clear(): void {
    this.docs.clear();
  }

  load(): Promise<PlanState> {
    return Promise.resolve(new Map(this.docs));
  }
}

/** main に計画が 1 つも無い、本物と同じ読み手 */
export const noMainPlans: PlanRepository = new RefPlanRepository(() => Promise.resolve(ok([])));
