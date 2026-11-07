import { describe, it, expect } from 'vitest';
import type { Card } from '../../../cards/models/card.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { ForgeConnection } from '../../models/mr-state.js';
import type { PlanDoc } from '../../models/plan-state.js';
import { needsBranchPlan } from '../branch-plan-target.js';

const UNSET: ForgeConnection = { status: 'disabled', kind: null, reason: null };
const CONNECTED: ForgeConnection = { status: 'connected', kind: 'github' };
const UNAVAILABLE: ForgeConnection = { status: 'disabled', kind: 'github', reason: 'gh が無い' };

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 'a' as CardId,
    title: 'a',
    created: '2026-11-01T00:00:00.000Z',
    startedAt: '2026-11-02T00:00:00.000Z',
    skipGates: [],
    branch: 'a',
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

describe('needsBranchPlan', () => {
  it('未設定のボードで、着手済み・ブランチあり・メインに計画なし・未提出か提出済みなら読む', () => {
    expect(needsBranchPlan({ forge: UNSET, card: card(), plan: null })).toBe(true);
    expect(needsBranchPlan({ forge: UNSET, card: card({ body: log('提出') }), plan: null })).toBe(
      true
    );
  });

  it('接続済み・使えないボードでは読まない', () => {
    expect(needsBranchPlan({ forge: CONNECTED, card: card(), plan: null })).toBe(false);
    expect(needsBranchPlan({ forge: UNAVAILABLE, card: card(), plan: null })).toBe(false);
  });

  it('メインに計画がある・未着手・ブランチなし・中止なら読まない', () => {
    expect(needsBranchPlan({ forge: UNSET, card: card(), plan: mainPlan })).toBe(false);
    expect(needsBranchPlan({ forge: UNSET, card: card({ startedAt: null }), plan: null })).toBe(
      false
    );
    expect(needsBranchPlan({ forge: UNSET, card: card({ branch: null }), plan: null })).toBe(false);
    expect(
      needsBranchPlan({ forge: UNSET, card: card({ body: log('提出', '中止') }), plan: null })
    ).toBe(false);
  });

  it('承認済み・差し戻し・保留のカードは読まない（列が計画の有無に依らない）', () => {
    for (const body of [
      log('提出', '承認'),
      log('提出', '差し戻し'),
      log('提出', '差し戻し', '保留'),
    ]) {
      expect(needsBranchPlan({ forge: UNSET, card: card({ body }), plan: null })).toBe(false);
    }
  });
});
