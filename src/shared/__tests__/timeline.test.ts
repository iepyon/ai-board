import { describe, it, expect } from 'vitest';
import { TIMELINE_KINDS, TIMELINE_OWNERS } from '../timeline.js';

// ============================================================
// 区間の種類と担当
// ============================================================

describe('TIMELINE_KINDS', () => {
  it('9 種類で、重なりが無い', () => {
    expect(TIMELINE_KINDS).toHaveLength(9);
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

    expect(ai).toEqual(['planning', 'plan-rework', 'implementing', 'readying']);
  });
});
