import { describe, it, expect } from 'vitest';
import { TIMELINE_KINDS, TIMELINE_OWNERS, segmentMs } from '../timeline.js';

// ============================================================
// 区間の種類と担当
// ============================================================

describe('TIMELINE_KINDS', () => {
  it('8 種類で、重なりが無い', () => {
    expect(TIMELINE_KINDS).toHaveLength(8);
    expect(new Set(TIMELINE_KINDS).size).toBe(TIMELINE_KINDS.length);
  });
});

describe('TIMELINE_OWNERS', () => {
  it('人の判断を待つ区間は human', () => {
    const human = TIMELINE_KINDS.filter((kind) => TIMELINE_OWNERS[kind] === 'human');

    expect(human).toEqual(['idea', 'plan-review', 'plan-held', 'pr-review', 'draft-returned']);
  });

  it('AI が作業する区間は ai', () => {
    const ai = TIMELINE_KINDS.filter((kind) => TIMELINE_OWNERS[kind] === 'ai');

    expect(ai).toEqual(['planning', 'plan-rework', 'implementing']);
  });
});

describe('segmentMs', () => {
  const GENERATED_AT = '2026-11-03T00:00:00.000Z';

  it('end が null なら generatedAt までを数え、読めない・逆向きの区間は 0', () => {
    expect(segmentMs({ start: '2026-11-02T23:00:00.000Z', end: null }, GENERATED_AT)).toBe(
      60 * 60 * 1000
    );
    expect(segmentMs({ start: 'x', end: null }, GENERATED_AT)).toBe(0);
    expect(
      segmentMs(
        { start: '2026-11-02T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
        GENERATED_AT
      )
    ).toBe(0);
  });
});
