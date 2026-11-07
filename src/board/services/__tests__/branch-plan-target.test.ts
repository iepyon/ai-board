import { describe, it, expect } from 'vitest';
import type { Card } from '../../../cards/models/card.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { PlanDoc } from '../../models/plan-state.js';
import { branchPlanTarget } from '../branch-plan-target.js';

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 'a' as CardId,
    title: 'a',
    created: '2026-11-01T00:00:00.000Z',
    startedAt: '2026-11-02T00:00:00.000Z',
    skipGates: [],
    branch: 'feat/a',
    mr: null,
    rank: null,
    body: '',
    ...overrides,
  };
}

const log = (...kinds: string[]): string =>
  `## レビュー\n\n${kinds
    .map((kind, i) => `### 2026-11-03T0${i}:00:00.000Z plan ${kind}\n\n理由\n`)
    .join('\n')}`;

const mainPlan: PlanDoc = {
  cardId: 'a' as CardId,
  tasks: { completed: 0, total: 1 },
  archived: false,
  updatedAt: '2026-11-03T00:00:00.000Z',
};

describe('branchPlanTarget', () => {
  it('着手済み・ブランチあり・メインに計画なし・未提出か提出済みなら、読むブランチを返す', () => {
    expect(branchPlanTarget(card(), null)).toBe('feat/a');
    expect(branchPlanTarget(card({ body: log('提出') }), null)).toBe('feat/a');
  });

  it('メインに計画がある・未着手・ブランチなし・中止なら読まない', () => {
    expect(branchPlanTarget(card(), mainPlan)).toBeNull();
    expect(branchPlanTarget(card({ startedAt: null }), null)).toBeNull();
    expect(branchPlanTarget(card({ branch: null }), null)).toBeNull();
    expect(branchPlanTarget(card({ body: log('提出', '中止') }), null)).toBeNull();
  });

  it('承認済み・差し戻し・保留のカードは読まない（計画レビューの規則が当たらない）', () => {
    for (const body of [
      log('提出', '承認'),
      log('提出', '差し戻し'),
      log('提出', '差し戻し', '保留'),
    ]) {
      expect(branchPlanTarget(card({ body }), null)).toBeNull();
    }
  });
});
