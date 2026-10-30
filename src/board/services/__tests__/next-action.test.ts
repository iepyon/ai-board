import { describe, it, expect } from 'vitest';
import {
  HOLD_REASONS,
  findStuckCards,
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
  return { aborted: false, gates: gate('none'), skipGates: [], hold: null, ...overrides };
}

const HOLD = { reason: '止まっている', since: '2026-10-30T00:00:00.000Z' };

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
      makeCard({ id: 'stuck', stage: 'planning', gates: gate('submitted'), hold: HOLD }),
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
      makeCard({ id: 'held', stage: 'impling', gates: gate('approved', 'held'), hold: HOLD }),
      makeCard({ id: 'next', stage: 'impling', gates: gate('approved', 'none') }),
    ]);

    expect(next).toEqual({ cardId: 'next', action: 'implement', reason: '計画が承認されている' });
  });

  it('作業者が保留を書いて止まった計画提案中のカードは飛ばす', () => {
    const next = pickNextAction([
      makeCard({ id: 'held', stage: 'planning', gates: gate('held'), hold: HOLD }),
      makeCard({ id: 'fresh', stage: 'planning' }),
    ]);

    expect(next?.cardId).toBe('fresh');
  });

  it('止まっているカードは、ゲートの状態が手を示していても飛ばして後ろのカードを選ぶ', () => {
    const next = pickNextAction([
      makeCard({
        id: 'reverted',
        stage: 'impling',
        gates: gate('approved', 'approved'),
        hold: HOLD,
      }),
      makeCard({ id: 'next', stage: 'impling', gates: gate('approved', 'rejected') }),
    ]);

    expect(next).toEqual({ cardId: 'next', action: 'revise-impl', reason: '動作確認で否決された' });
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
  it('止まっているカードを理由付きで返す', () => {
    const stuck = findStuckCards([
      makeCard({ id: 'held', stage: 'impling', gates: gate('approved', 'held'), hold: HOLD }),
      makeCard({ id: 'fresh', stage: 'planning' }),
    ]);

    expect(stuck).toEqual([{ cardId: 'held', reason: '止まっている' }]);
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
    ...rest,
  };
}

const draftMr = (convertedToDraftAt: string | null): HoldInput['mr'] => ({
  iid: 38,
  convertedToDraftAt,
});

describe('resolveHold', () => {
  const approvedPlan = [entry(0, 'plan', '提出'), entry(1, 'plan', '承認')];

  it('verify 保留の実装中のカードは、保留の時刻から止まる', () => {
    const hold = resolveHold(
      holdInput('impling', [
        ...approvedPlan,
        entry(2, 'verify', '提出'),
        entry(3, 'verify', '否決'),
        entry(4, 'verify', '保留', '直すには大きすぎる'),
      ])
    );

    expect(hold).toEqual({ reason: HOLD_REASONS.verifyHeld, since: entry(4, 'verify', '保留').at });
  });

  it('保留の後に人が否決を書くと止まりが外れ、revise-impl が選ばれる', () => {
    const input = holdInput('impling', [
      ...approvedPlan,
      entry(2, 'verify', '提出'),
      entry(3, 'verify', '否決'),
      entry(4, 'verify', '保留'),
      entry(5, 'verify', '否決', '検索だけ直せばよい'),
    ]);
    const hold = resolveHold(input);

    expect(hold).toBeNull();
    expect(
      pickNextAction([makeCard({ id: 'a', stage: 'impling', gates: input.gates, hold })])
    ).toEqual({ cardId: 'a', action: 'revise-impl', reason: '動作確認で否決された' });
  });

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

  it('手を出してよい計画提案中・実装中のカードは止まらない', () => {
    expect(resolveHold(holdInput('planning', []))).toBeNull();
    expect(
      resolveHold(holdInput('planning', [entry(0, 'plan', '提出'), entry(1, 'plan', '否決')]))
    ).toBeNull();
    expect(resolveHold(holdInput('impling', approvedPlan))).toBeNull();
  });

  it('中止のカードと AI の列でないカードは止まりにしない', () => {
    const held = [...approvedPlan, entry(2, 'verify', '保留')];

    expect(resolveHold(holdInput('impling', held, { aborted: true }))).toBeNull();
    expect(resolveHold(holdInput('verifying', held))).toBeNull();
  });

  it('動作確認の承認の後に PR が Draft に戻されたら、ready を選ばずに止まる', () => {
    const convertedAt = '2026-10-20T01:00:00Z';
    const input = holdInput(
      'impling',
      [...approvedPlan, entry(2, 'verify', '提出'), entry(3, 'verify', '承認')],
      { mr: draftMr(convertedAt) }
    );
    const hold = resolveHold(input);

    expect(hold).toEqual({ reason: HOLD_REASONS.draftReverted(38), since: convertedAt });
    expect(hold?.reason).toContain('PR #38');
    expect(
      pickNextAction([makeCard({ id: 'a', stage: 'impling', gates: input.gates, hold })])
    ).toBeNull();
  });

  it('動作確認を飛ばす宣言のカードも、Draft に戻されたら implement を選ばずに止まる', () => {
    const input = holdInput('impling', approvedPlan, {
      skipGates: ['verify'],
      mr: draftMr('2026-10-20T01:00:00Z'),
    });
    const hold = resolveHold(input);

    expect(hold?.reason).toBe(HOLD_REASONS.draftReverted(38));
    expect(
      pickNextAction([
        makeCard({ id: 'a', stage: 'impling', gates: input.gates, skipGates: ['verify'], hold }),
      ])
    ).toBeNull();
  });

  it('Draft に戻された時刻が最新のエントリより古ければ止まらない', () => {
    const hold = resolveHold(
      holdInput(
        'impling',
        [...approvedPlan, entry(2, 'verify', '提出'), entry(3, 'verify', '否決')],
        {
          mr: draftMr('2026-10-20T00:02:30Z'),
        }
      )
    );

    expect(hold).toBeNull();
  });

  it('Draft に戻されたことの判定は verify 保留より先に見る', () => {
    const convertedAt = '2026-10-20T01:00:00Z';
    const hold = resolveHold(
      holdInput('impling', [...approvedPlan, entry(2, 'verify', '保留')], {
        mr: draftMr(convertedAt),
      })
    );

    expect(hold).toEqual({ reason: HOLD_REASONS.draftReverted(38), since: convertedAt });
  });

  it('レビューのエントリが 1 件も無いカードは、Draft に戻された時点で止まる', () => {
    const hold = resolveHold(
      holdInput('impling', [], { skipGates: ['plan'], mr: draftMr('2026-10-20T01:00:00Z') })
    );

    expect(hold?.reason).toBe(HOLD_REASONS.draftReverted(38));
  });

  it('Draft に戻されたことが無い PR では止まらない', () => {
    expect(resolveHold(holdInput('impling', approvedPlan, { mr: draftMr(null) }))).toBeNull();
  });
});
