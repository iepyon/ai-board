import { describe, it, expect } from 'vitest';
import type { LoopStep } from '../loop-step.js';
import {
  describeAction,
  formatElapsed,
  isCardRunning,
  runningStepOf,
  summarizeLoop,
  toBoardLoop,
} from '../loop-activity.js';

const GENERATED = '2026-11-02T12:00:00.000Z';

function step(overrides: Partial<LoopStep> = {}): LoopStep {
  return {
    loop: 'session-a',
    cardId: 'card-a',
    action: 'implement',
    step: 'task',
    agent: null,
    startedAt: '2026-11-02T11:48:00.000Z',
    finishedAt: null,
    result: null,
    ...overrides,
  };
}

const done = (overrides: Partial<LoopStep> = {}): LoopStep =>
  step({ result: 'advanced', finishedAt: '2026-11-02T11:20:00.000Z', ...overrides });

describe('toBoardLoop', () => {
  it('ループごとに最新の終わっていない記録と、最後に終えた時刻を返す', () => {
    const loop = toBoardLoop([
      done({ finishedAt: '2026-11-02T10:00:00.000Z' }),
      done({ result: 'interrupted', finishedAt: '2026-11-02T11:00:00.000Z' }),
      step({ loop: 'b', cardId: 'card-b', startedAt: '2026-11-02T11:50:00.000Z' }),
      step({ startedAt: '2026-11-02T11:30:00.000Z' }),
      step({ startedAt: '2026-11-02T11:40:00.000Z', cardId: 'card-c' }),
    ]);

    expect(loop.running.map((s) => [s.loop, s.cardId])).toEqual([
      ['session-a', 'card-c'],
      ['b', 'card-b'],
    ]);
    expect(loop.lastFinishedAt).toBe('2026-11-02T11:00:00.000Z');
  });

  it('記録が無ければ空', () => {
    expect(toBoardLoop([])).toEqual({ running: [], lastFinishedAt: null });
  });
});

describe('summarizeLoop', () => {
  const titles: Record<string, string> = { 'card-a': 'カード A' };
  const titleOf = (id: string): string | null => titles[id] ?? null;

  it('触っていれば、カードと手と始めてからの時間を出す', () => {
    expect(summarizeLoop(toBoardLoop([step()]), GENERATED, titleOf)).toEqual({
      state: 'running',
      text: 'ループ: カード A を implement（task） 中（12 分）',
    });
  });

  it('複数のループが触っていれば「、」でつなぐ。タイトルが無ければ ID を出す', () => {
    const loop = toBoardLoop([
      step(),
      step({ loop: 'b', cardId: 'card-b', action: 'plan', step: null, startedAt: GENERATED }),
    ]);
    expect(summarizeLoop(loop, GENERATED, titleOf).text).toBe(
      'ループ: カード A を implement（task） 中（12 分）、card-b を plan 中（0 分）'
    );
  });

  it('触っていなければ、最後の手からの時間を出す', () => {
    expect(summarizeLoop(toBoardLoop([done()]), GENERATED)).toEqual({
      state: 'idle',
      text: 'ループ: 最後の手から 40 分',
    });
  });

  it('記録が無ければ「記録なし」', () => {
    expect(summarizeLoop(toBoardLoop([]), GENERATED)).toEqual({
      state: 'none',
      text: 'ループ: 記録なし',
    });
  });
});

describe('runningStepOf / isCardRunning', () => {
  it('終わっていない記録のカードだけが触られている', () => {
    const loop = toBoardLoop([step(), done({ cardId: 'card-b' })]);
    expect(isCardRunning(loop, 'card-a')).toBe(true);
    expect(isCardRunning(loop, 'card-b')).toBe(false);
    expect(runningStepOf(loop, 'card-a')?.action).toBe('implement');
    expect(runningStepOf(loop, 'card-b')).toBeNull();
  });
});

describe('describeAction / formatElapsed', () => {
  it('段があれば添える', () => {
    expect(describeAction({ action: 'implement', step: 'review' })).toBe('implement（review）');
    expect(describeAction({ action: 'ready', step: null })).toBe('ready');
  });

  it('分・時間・日で出し、負は 0 分、読めない時刻は —', () => {
    expect(formatElapsed('2026-11-02T11:59:30.000Z', GENERATED)).toBe('0 分');
    expect(formatElapsed('2026-11-02T09:55:00.000Z', GENERATED)).toBe('2 時間 5 分');
    expect(formatElapsed('2026-10-30T08:00:00.000Z', GENERATED)).toBe('3 日 4 時間');
    expect(formatElapsed('2026-11-02T13:00:00.000Z', GENERATED)).toBe('0 分');
    expect(formatElapsed('nope', GENERATED)).toBe('—');
  });
});
