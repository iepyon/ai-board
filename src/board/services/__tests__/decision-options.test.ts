import { describe, it, expect } from 'vitest';
import { decisionsFor, type DecisionCard } from '../decision-options.js';

// ============================================================
// 出せる判断
// ============================================================

function decisionCard(overrides: Partial<DecisionCard> = {}): DecisionCard {
  return {
    stage: 'idea',
    aborted: false,
    hold: null,
    gates: { plan: 'none' },
    ...overrides,
  };
}

const HOLD = { kind: 'decision' as const, reason: '止まっている', since: '2026-09-20T00:00:00Z' };

/** 判断を `gate kind ラベル` の文字列に縮める。並びも確かめる */
const buttons = (card: DecisionCard): string[] =>
  decisionsFor(card).map((decision) => `${decision.gate} ${decision.kind} ${decision.label}`);

describe('decisionsFor', () => {
  it('計画レビューは plan の 承認 / 差し戻し / 中止', () => {
    expect(buttons(decisionCard({ stage: 'plan-review' }))).toEqual([
      'plan 承認 承認',
      'plan 差し戻し 差し戻す',
      'plan 中止 中止する',
    ]);
  });

  it('実装中で止まっていれば（PR が Draft に戻された）、計画から立て直させる / 中止', () => {
    const card = decisionCard({ stage: 'impling', hold: HOLD, gates: { plan: 'approved' } });

    expect(buttons(card)).toEqual(['plan 差し戻し 計画から立て直させる', 'plan 中止 中止する']);
  });

  it('計画提案中で plan 保留なら、計画を直させる / 中止', () => {
    const card = decisionCard({ stage: 'planning', hold: HOLD, gates: { plan: 'held' } });

    expect(buttons(card)).toEqual(['plan 差し戻し 計画を直させる', 'plan 中止 中止する']);
  });

  it('計画提案中で提出済みなのに成果物が見えなければ、中止だけ', () => {
    const card = decisionCard({ stage: 'planning', hold: HOLD, gates: { plan: 'submitted' } });

    expect(buttons(card)).toEqual(['plan 中止 中止する']);
  });

  it('差し戻しはどれも理由が要り、承認と中止は要らない', () => {
    for (const stage of ['plan-review', 'impling'] as const) {
      for (const decision of decisionsFor(decisionCard({ stage, hold: HOLD }))) {
        expect(decision.reasonRequired).toBe(decision.kind === '差し戻し');
      }
    }
  });

  it('アイデアは plan の 中止 だけ（理由は要らない）', () => {
    const card = decisionCard({ stage: 'idea' });

    expect(buttons(card)).toEqual(['plan 中止 中止する']);
    expect(decisionsFor(card)[0]?.reasonRequired).toBe(false);
  });

  it('中止したアイデアには出さない', () => {
    expect(decisionsFor(decisionCard({ stage: 'idea', aborted: true }))).toEqual([]);
  });

  it('止まっていない AI の列、PR中、マージ済みには出さない', () => {
    for (const stage of ['planning', 'impling', 'pr', 'merged'] as const) {
      expect(decisionsFor(decisionCard({ stage }))).toEqual([]);
    }
  });

  it('PR の状態を引けない止まりのカードには、どの列でも出さない', () => {
    const forgeHold = { ...HOLD, kind: 'forge' as const };

    for (const stage of ['plan-review', 'impling', 'planning'] as const) {
      expect(decisionsFor(decisionCard({ stage, hold: forgeHold }))).toEqual([]);
    }
  });

  it('PR中 は止まりがあっても GitHub で判断するので出さない', () => {
    expect(decisionsFor(decisionCard({ stage: 'pr', hold: HOLD }))).toEqual([]);
  });

  it('中止のカードには、ゲートを待つ列でも止まっていても出さない', () => {
    for (const stage of ['idea', 'plan-review', 'impling', 'planning'] as const) {
      expect(decisionsFor(decisionCard({ stage, hold: HOLD, aborted: true }))).toEqual([]);
    }
  });

  it('plan を飛ばすカードが実装中で止まっても、計画から立て直させるを出す', () => {
    // plan を飛ばすカードの plan ゲートは、AI の plan 提出 を承認と読んだ approved
    const card = {
      ...decisionCard({ stage: 'impling', hold: HOLD, gates: { plan: 'approved' } }),
      skipGates: ['plan'],
    };

    expect(buttons(card)).toEqual(['plan 差し戻し 計画から立て直させる', 'plan 中止 中止する']);
  });
});
