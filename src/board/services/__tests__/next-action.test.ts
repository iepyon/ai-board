import { describe, it, expect } from 'vitest';
import {
  HOLD_REASONS,
  pickNextAction,
  resolveHold,
  type HoldInput,
  type NextActionCard,
} from '../next-action.js';
import type {
  GateState,
  ReviewEntry,
  ReviewGate,
  ReviewKind,
} from '../../../cards/models/review.js';
import { gateStates } from '../../../cards/services/review-log.js';

function makeCard(
  overrides: Partial<NextActionCard> & Pick<NextActionCard, 'id' | 'stage'>
): NextActionCard {
  return { aborted: false, gates: gate('none'), hold: null, ...overrides };
}

const HOLD = { reason: '止まっている', since: '2026-10-30T00:00:00.000Z' };

const gate = (plan: GateState): NextActionCard['gates'] => ({ plan });

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
      step: null,
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

    expect(next).toEqual({
      cardId: 'a',
      action: 'revise-plan',
      reason: '計画が否決された',
      step: null,
    });
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
      makeCard({ id: 'stuck', stage: 'planning', gates: gate('submitted'), hold: HOLD }),
      makeCard({ id: 'fresh', stage: 'planning' }),
    ]);

    expect(next?.cardId).toBe('fresh');
  });

  it('止まっていない実装中は、いつも implement', () => {
    const next = pickNextAction([makeCard({ id: 'a', stage: 'impling', gates: gate('approved') })]);

    expect(next).toEqual({
      cardId: 'a',
      action: 'implement',
      reason: '計画が承認されている',
      step: null,
    });
  });

  it('止まっている実装中のカードは飛ばして、次のカードを選ぶ', () => {
    const next = pickNextAction([
      makeCard({ id: 'reverted', stage: 'impling', gates: gate('approved'), hold: HOLD }),
      makeCard({ id: 'next', stage: 'impling', gates: gate('approved') }),
    ]);

    expect(next?.cardId).toBe('next');
  });

  it('AI が保留を書いて止まった計画提案中のカードは飛ばす', () => {
    const next = pickNextAction([
      makeCard({ id: 'held', stage: 'planning', gates: gate('held'), hold: HOLD }),
      makeCard({ id: 'fresh', stage: 'planning' }),
    ]);

    expect(next?.cardId).toBe('fresh');
  });

  it('人の判断を待つ列やアイデア・マージ済みしか無ければ null', () => {
    const next = pickNextAction([
      makeCard({ id: 'idea', stage: 'idea' }),
      makeCard({ id: 'review', stage: 'plan-review', gates: gate('submitted') }),
      makeCard({ id: 'pr', stage: 'pr', gates: gate('approved') }),
      makeCard({ id: 'merged', stage: 'merged', gates: gate('approved') }),
    ]);

    expect(next).toBeNull();
  });
});

// ============================================================
// resolveHold
// ============================================================

const T0 = '2026-10-20T00:00:00.000Z';

function entry(minute: number, gate: ReviewGate, kind: ReviewKind, reason = ''): ReviewEntry {
  return { at: `2026-10-20T00:${String(minute).padStart(2, '0')}:00.000Z`, gate, kind, reason };
}

/** ステージだけ与え、ゲートの状態は本物の規則（gateStates）でエントリから出す */
function holdInput(
  stage: HoldInput['stage'],
  entries: ReviewEntry[],
  overrides: Partial<HoldInput> & { skipGates?: ReviewGate[] } = {}
): HoldInput {
  const { skipGates = [], ...rest } = overrides;
  return {
    stage,
    aborted: false,
    gates: gateStates(entries, skipGates),
    entries,
    mr: null,
    mrKnown: true,
    ...rest,
  };
}

const draftMr = (convertedToDraftAt: string | null): HoldInput['mr'] => ({
  iid: 38,
  convertedToDraftAt,
});

describe('resolveHold', () => {
  const approvedPlan = [entry(0, 'plan', '提出'), entry(1, 'plan', '承認')];

  it('plan 保留の計画提案中のカードは止まる', () => {
    const hold = resolveHold(
      holdInput('planning', [
        entry(0, 'plan', '提出'),
        entry(1, 'plan', '否決'),
        entry(2, 'plan', '保留'),
      ])
    );

    expect(hold).toEqual({ reason: HOLD_REASONS.planHeld, since: entry(2, 'plan', '保留').at });
  });

  it('提出済みなのに計画提案中にいるカードは、提出の時刻から止まる', () => {
    const hold = resolveHold(holdInput('planning', [entry(0, 'plan', '提出')]));

    expect(hold).toEqual({ reason: HOLD_REASONS.planLost, since: T0 });
  });

  it('PR の状態を引けていなければ、提出済みの計画提案中のカードを止まりにしない', () => {
    const hold = resolveHold(holdInput('planning', [entry(0, 'plan', '提出')], { mrKnown: false }));

    expect(hold).toBeNull();
  });

  it('手を出してよい計画提案中・実装中のカードは止まらない', () => {
    expect(resolveHold(holdInput('planning', []))).toBeNull();
    expect(
      resolveHold(holdInput('planning', [entry(0, 'plan', '提出'), entry(1, 'plan', '否決')]))
    ).toBeNull();
    expect(resolveHold(holdInput('impling', approvedPlan))).toBeNull();
  });

  it('中止のカードと AI の列でないカードは止まりにしない', () => {
    const mr = draftMr('2026-10-20T01:00:00Z');

    expect(resolveHold(holdInput('impling', approvedPlan, { aborted: true, mr }))).toBeNull();
    expect(resolveHold(holdInput('pr', approvedPlan, { mr }))).toBeNull();
  });

  it('計画の承認の後に PR が Draft に戻されたら、implement を選ばずに止まる', () => {
    // Ready にした PR を人が Draft に戻すと 実装中 に落ちる。止めないと archive 済みの段が Ready に戻してしまう
    const convertedAt = '2026-10-20T01:00:00Z';
    const input = holdInput('impling', approvedPlan, { mr: draftMr(convertedAt) });
    const hold = resolveHold(input);

    expect(hold).toEqual({ reason: HOLD_REASONS.draftReverted(38), since: convertedAt });
    expect(hold?.reason).toContain('PR #38');
    expect(
      pickNextAction([makeCard({ id: 'a', stage: 'impling', gates: input.gates, hold })])
    ).toBeNull();
  });

  it('Draft に戻された時刻が最新のエントリより古ければ止まらない', () => {
    const hold = resolveHold(
      holdInput('impling', approvedPlan, { mr: draftMr('2026-10-20T00:00:30Z') })
    );

    expect(hold).toBeNull();
  });

  it('plan を飛ばす宣言のカードは、plan 提出 より後に Draft に戻されたら止まる', () => {
    const submitted = [entry(0, 'plan', '提出')];
    const hold = resolveHold(
      holdInput('impling', submitted, { skipGates: ['plan'], mr: draftMr('2026-10-20T01:00:00Z') })
    );

    expect(hold?.reason).toBe(HOLD_REASONS.draftReverted(38));
    expect(
      resolveHold(
        holdInput('impling', submitted, {
          skipGates: ['plan'],
          mr: draftMr('2026-10-19T23:00:00Z'),
        })
      )
    ).toBeNull();
  });

  it('plan を飛ばす宣言の着手済みのカードには plan が選ばれ、提出の後は implement が選ばれる', () => {
    const before = holdInput('planning', [], { skipGates: ['plan'] });
    const after = holdInput('impling', [entry(0, 'plan', '提出')], { skipGates: ['plan'] });

    expect(before.gates.plan).toBe('none');
    expect(
      pickNextAction([
        makeCard({
          id: 'a',
          stage: 'planning',
          gates: before.gates,
          hold: resolveHold(before),
        }),
      ])?.action
    ).toBe('plan');

    expect(after.gates.plan).toBe('approved');
    expect(
      pickNextAction([
        makeCard({
          id: 'a',
          stage: 'impling',
          gates: after.gates,
          hold: resolveHold(after),
        }),
      ])?.action
    ).toBe('implement');
  });

  it('Draft に戻されたことが無い PR では止まらない', () => {
    expect(resolveHold(holdInput('impling', approvedPlan, { mr: draftMr(null) }))).toBeNull();
  });
});
