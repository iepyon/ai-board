import { describe, it, expect } from 'vitest';
import { stuckStreak, type StreakStep } from '../loop-streak.js';

/** 記録は開始の古い順に並べて渡す（`minute` は並びを読みやすくするための目印） */
function step(_minute: number, overrides: Partial<StreakStep> = {}): StreakStep {
  return { action: 'implement', step: 'task', result: 'stopped', ...overrides };
}

describe('stuckStreak', () => {
  it('最新と同じ手・同じ段で、進めなかった記録が続く数を数える', () => {
    expect(
      stuckStreak([
        step(1, { result: 'advanced' }),
        step(2),
        step(3, { result: 'interrupted' }),
        step(4, { result: 'held' }),
      ])
    ).toBe(3);
  });

  it('手や段が変われば、そこで数えるのをやめる', () => {
    expect(stuckStreak([step(1), step(2, { step: 'close' }), step(3, { step: 'close' })])).toBe(2);
    expect(stuckStreak([step(1, { action: 'plan', step: null }), step(2)])).toBe(1);
  });

  it('最新が進めた・終わっていない・記録が無ければ 0', () => {
    expect(stuckStreak([step(1), step(2, { result: 'advanced' })])).toBe(0);
    expect(stuckStreak([step(1), step(2, { result: null })])).toBe(0);
    expect(stuckStreak([])).toBe(0);
  });
});
