import { describe, it, expect } from 'vitest';
import type { TimelineSegment } from '../../../shared/timeline.js';
import { splitAiPhases, type PhaseStep } from '../timeline-phases.js';

const T = (hour: number): string => new Date(Date.UTC(2026, 10, 2, hour)).toISOString();

function ai(start: number, end: number | null): TimelineSegment {
  return { kind: 'implementing', owner: 'ai', start: T(start), end: end === null ? null : T(end) };
}

function step(start: number, end: number | null): PhaseStep {
  return { startedAt: T(start), finishedAt: end === null ? null : T(end) };
}

function phasesOf(segment: TimelineSegment, steps: readonly PhaseStep[]): unknown {
  return splitAiPhases([segment], steps)[0]?.phases;
}

describe('splitAiPhases', () => {
  it('人の区間の phases は空', () => {
    const human: TimelineSegment = { kind: 'verifying', owner: 'human', start: T(0), end: T(10) };
    expect(phasesOf(human, [step(1, 2)])).toEqual([]);
  });

  it('記録の重ならない AI の区間の phases は空', () => {
    expect(phasesOf(ai(0, 10), [])).toEqual([]);
    expect(phasesOf(ai(0, 10), [step(11, 12)])).toEqual([]);
  });

  it('待ちと作業が交互に並ぶ', () => {
    expect(phasesOf(ai(0, 10), [step(2, 3), step(5, 6)])).toEqual([
      { kind: 'wait', start: T(0), end: T(2) },
      { kind: 'work', start: T(2), end: T(3) },
      { kind: 'wait', start: T(3), end: T(5) },
      { kind: 'work', start: T(5), end: T(6) },
      { kind: 'wait', start: T(6), end: T(10) },
    ]);
  });

  it('区間の外にはみ出した記録を区間で切る', () => {
    expect(phasesOf(ai(2, 8), [step(0, 3), step(7, 12)])).toEqual([
      { kind: 'work', start: T(2), end: T(3) },
      { kind: 'wait', start: T(3), end: T(7) },
      { kind: 'work', start: T(7), end: T(8) },
    ]);
  });

  it('重なる記録と接する記録は 1 つの作業につなぐ', () => {
    expect(phasesOf(ai(0, 10), [step(4, 6), step(1, 5), step(6, 7)])).toEqual([
      { kind: 'wait', start: T(0), end: T(1) },
      { kind: 'work', start: T(1), end: T(7) },
      { kind: 'wait', start: T(7), end: T(10) },
    ]);
  });

  it('終わっていない区間の後ろの待ちは end: null', () => {
    expect(phasesOf(ai(0, null), [step(1, 2)])).toEqual([
      { kind: 'wait', start: T(0), end: T(1) },
      { kind: 'work', start: T(1), end: T(2) },
      { kind: 'wait', start: T(2), end: null },
    ]);
  });

  it('終わっていない記録は、終わっていない区間では end: null、終わった区間では区間の終わりまで', () => {
    expect(phasesOf(ai(0, null), [step(3, null)])).toEqual([
      { kind: 'wait', start: T(0), end: T(3) },
      { kind: 'work', start: T(3), end: null },
    ]);
    expect(phasesOf(ai(0, 5), [step(3, null)])).toEqual([
      { kind: 'wait', start: T(0), end: T(3) },
      { kind: 'work', start: T(3), end: T(5) },
    ]);
  });

  it('区間ごとに分け、区間そのものの項目は変えない', () => {
    const segments: TimelineSegment[] = [
      ai(0, 2),
      { kind: 'plan-review', owner: 'human', start: T(2), end: T(4) },
      { ...ai(4, 6), kind: 'plan-rework' },
    ];
    const result = splitAiPhases(segments, [step(1, 2), step(5, 6)]);

    expect(result.map(({ phases: _phases, ...segment }) => segment)).toEqual(segments);
    expect(result.map((segment) => segment.phases.map((p) => p.kind))).toEqual([
      ['wait', 'work'],
      [],
      ['wait', 'work'],
    ]);
  });
});
