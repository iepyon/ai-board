import { describe, it, expect } from 'vitest';
import { findStuckCards, pickNextAction, type NextActionCard } from '../next-action.js';
import type { GateState } from '../../../cards/models/review.js';

function makeCard(
  overrides: Partial<NextActionCard> & Pick<NextActionCard, 'id' | 'stage'>
): NextActionCard {
  return { aborted: false, gates: gate('none'), skipGates: [], ...overrides };
}

const gate = (plan: GateState, verify: GateState = 'none'): NextActionCard['gates'] => ({
  plan,
  verify,
});

describe('pickNextAction', () => {
  it('実装中を計画提案中より先に選ぶ', () => {
    const next = pickNextAction([
      makeCard({ id: 'planning', stage: 'planning' }),
      makeCard({ id: 'impling', stage: 'impling', gates: gate('approved') }),
    ]);

    expect(next).toEqual({
      cardId: 'impling',
      action: 'implement',
      reason: '計画が承認されている',
    });
  });

  it('同じ列の中は受け取った順（rank の順）を保つ', () => {
    const next = pickNextAction([
      makeCard({ id: 'first', stage: 'planning' }),
      makeCard({ id: 'second', stage: 'planning' }),
    ]);

    expect(next?.cardId).toBe('first');
  });

  it('まだ何も提出していない計画提案中は plan', () => {
    expect(pickNextAction([makeCard({ id: 'a', stage: 'planning' })])?.action).toBe('plan');
  });

  it('否決されて計画提案中へ落ちたカードは revise-plan', () => {
    const next = pickNextAction([
      makeCard({ id: 'a', stage: 'planning', gates: gate('rejected') }),
    ]);

    expect(next).toEqual({ cardId: 'a', action: 'revise-plan', reason: '計画が否決された' });
  });

  it('中止のカードは選ばない', () => {
    const next = pickNextAction([
      makeCard({ id: 'aborted', stage: 'impling', aborted: true }),
      makeCard({ id: 'alive', stage: 'planning' }),
    ]);

    expect(next?.cardId).toBe('alive');
  });

  it('提出済みなのに成果物が見えないカードは飛ばして、次のカードを選ぶ', () => {
    const next = pickNextAction([
      makeCard({ id: 'stuck', stage: 'planning', gates: gate('submitted') }),
      makeCard({ id: 'fresh', stage: 'planning' }),
    ]);

    expect(next?.cardId).toBe('fresh');
  });

  it('動作確認をまだ頼んでいない実装中は implement', () => {
    const next = pickNextAction([
      makeCard({ id: 'a', stage: 'impling', gates: gate('approved', 'none') }),
    ]);

    expect(next?.action).toBe('implement');
  });

  it('動作確認で否決されて実装中へ落ちたカードは revise-impl', () => {
    const next = pickNextAction([
      makeCard({ id: 'a', stage: 'impling', gates: gate('approved', 'rejected') }),
    ]);

    expect(next).toEqual({ cardId: 'a', action: 'revise-impl', reason: '動作確認で否決された' });
  });

  it('動作確認を人が承認したカードは ready', () => {
    const next = pickNextAction([
      makeCard({ id: 'a', stage: 'impling', gates: gate('approved', 'approved') }),
    ]);

    expect(next).toEqual({ cardId: 'a', action: 'ready', reason: '動作確認が承認された' });
  });

  it('動作確認を飛ばす宣言による承認は ready ではなく implement', () => {
    const next = pickNextAction([
      makeCard({
        id: 'a',
        stage: 'impling',
        gates: gate('approved', 'approved'),
        skipGates: ['verify'],
      }),
    ]);

    expect(next?.action).toBe('implement');
  });

  it('動作確認を待つカードは選ばず、次のカードを選ぶ', () => {
    const next = pickNextAction([
      makeCard({ id: 'verifying', stage: 'verifying', gates: gate('approved', 'submitted') }),
      makeCard({ id: 'planning', stage: 'planning' }),
    ]);

    expect(next?.cardId).toBe('planning');
  });

  it('作業者が保留を書いて止まった実装中のカードは飛ばして、次のカードを選ぶ', () => {
    const next = pickNextAction([
      makeCard({ id: 'held', stage: 'impling', gates: gate('approved', 'held') }),
      makeCard({ id: 'next', stage: 'impling', gates: gate('approved', 'none') }),
    ]);

    expect(next).toEqual({ cardId: 'next', action: 'implement', reason: '計画が承認されている' });
  });

  it('作業者が保留を書いて止まった計画提案中のカードは飛ばす', () => {
    const next = pickNextAction([
      makeCard({ id: 'held', stage: 'planning', gates: gate('held') }),
      makeCard({ id: 'fresh', stage: 'planning' }),
    ]);

    expect(next?.cardId).toBe('fresh');
  });

  it('人の判断を待つ列やアイデア・マージ済みしか無ければ null', () => {
    const next = pickNextAction([
      makeCard({ id: 'idea', stage: 'idea' }),
      makeCard({ id: 'review', stage: 'plan-review', gates: gate('submitted') }),
      makeCard({ id: 'verifying', stage: 'verifying', gates: gate('approved', 'submitted') }),
      makeCard({ id: 'pr', stage: 'pr', gates: gate('approved') }),
      makeCard({ id: 'merged', stage: 'merged', gates: gate('approved') }),
    ]);

    expect(next).toBeNull();
  });
});

describe('findStuckCards', () => {
  it('計画提案中で plan ゲートが提出済みのカードを理由付きで返す', () => {
    const stuck = findStuckCards([
      makeCard({ id: 'submitted', stage: 'planning', gates: gate('submitted') }),
      makeCard({ id: 'resubmitted', stage: 'planning', gates: gate('submitted') }),
      makeCard({ id: 'fresh', stage: 'planning' }),
      makeCard({ id: 'review', stage: 'plan-review', gates: gate('submitted') }),
    ]);

    expect(stuck.map((card) => card.cardId)).toEqual(['submitted', 'resubmitted']);
    expect(stuck[0]?.reason).toContain('計画ファイルも Draft の PR も見えない');
  });

  it('ゲートが held のカードを理由付きで返す', () => {
    const stuck = findStuckCards([
      makeCard({ id: 'verify-held', stage: 'impling', gates: gate('approved', 'held') }),
      makeCard({ id: 'plan-held', stage: 'planning', gates: gate('held') }),
    ]);

    expect(stuck.map((card) => card.cardId)).toEqual(['verify-held', 'plan-held']);
    expect(stuck[0]?.reason).toContain('verify 保留');
    expect(stuck[1]?.reason).toContain('plan 保留');
  });

  it('中止のカードは含めない', () => {
    const stuck = findStuckCards([
      makeCard({ id: 'a', stage: 'planning', aborted: true, gates: gate('submitted') }),
    ]);

    expect(stuck).toEqual([]);
  });
});
