import { describe, it, expect } from 'vitest';
import {
  checkRunOutcome,
  checksVerdict,
  commitStatusOutcome,
  summarizeChecks,
  type CheckRow,
  type RawCheckRun,
} from '../pr-checks.js';

const run = (overrides: Partial<RawCheckRun> = {}): RawCheckRun => ({
  name: 'test',
  status: 'completed',
  conclusion: 'success',
  html_url: 'https://example.test/run',
  ...overrides,
});

const row = (outcome: CheckRow['outcome']): CheckRow => ({
  name: outcome,
  source: 'check-run',
  outcome,
  detail: outcome,
  url: null,
});

describe('checkRunOutcome', () => {
  it.each(['success', 'neutral', 'skipped'])('%s は通った', (conclusion) => {
    expect(checkRunOutcome(run({ conclusion }))).toBe('passed');
  });

  it.each(['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'something-new'])(
    '%s は落ちた（知らない値も落ちたとみなす）',
    (conclusion) => {
      expect(checkRunOutcome(run({ conclusion }))).toBe('failed');
    }
  );

  it.each(['queued', 'in_progress', 'waiting', 'requested', 'pending'])(
    'status が %s なら走っている',
    (status) => {
      expect(checkRunOutcome(run({ status, conclusion: null }))).toBe('pending');
    }
  );

  it('終わっているのに conclusion が無ければ落ちた', () => {
    expect(checkRunOutcome(run({ conclusion: null }))).toBe('failed');
  });
});

describe('commitStatusOutcome', () => {
  it('pending は走っている、success は通った、failure / error は落ちた', () => {
    expect(commitStatusOutcome({ context: 'ci', state: 'pending' })).toBe('pending');
    expect(commitStatusOutcome({ context: 'ci', state: 'success' })).toBe('passed');
    expect(commitStatusOutcome({ context: 'ci', state: 'failure' })).toBe('failed');
    expect(commitStatusOutcome({ context: 'ci', state: 'error' })).toBe('failed');
  });
});

describe('checksVerdict', () => {
  it('行が無ければ none', () => {
    expect(checksVerdict([])).toBe('none');
  });

  it('落ちたものが 1 つでもあれば、走っているものがあっても failed', () => {
    expect(checksVerdict([row('passed'), row('pending'), row('failed')])).toBe('failed');
  });

  it('落ちたものが無く、走っているものがあれば pending', () => {
    expect(checksVerdict([row('passed'), row('pending')])).toBe('pending');
  });

  it('すべて通っていれば passed', () => {
    expect(checksVerdict([row('passed'), row('passed')])).toBe('passed');
  });
});

describe('summarizeChecks', () => {
  it('check-runs と status を突き合わせずに 1 つの表にまとめ、check-runs を先に名前の順に並べる', () => {
    const summary = summarizeChecks(
      'abc123',
      [
        run({ name: 'test (24)', details_url: 'https://example.test/d', html_url: null }),
        run({ name: 'build', status: 'in_progress', conclusion: null }),
      ],
      [{ context: 'build', state: 'failure', target_url: 'https://ci.example.test/1' }]
    );

    expect(summary.sha).toBe('abc123');
    expect(summary.verdict).toBe('failed');
    expect(summary.rows).toEqual([
      {
        name: 'build',
        source: 'check-run',
        outcome: 'pending',
        detail: 'in_progress',
        url: 'https://example.test/run',
      },
      {
        name: 'test (24)',
        source: 'check-run',
        outcome: 'passed',
        detail: 'success',
        url: 'https://example.test/d',
      },
      {
        name: 'build',
        source: 'status',
        outcome: 'failed',
        detail: 'failure',
        url: 'https://ci.example.test/1',
      },
    ]);
  });

  it('チェックが 1 つも無ければ none', () => {
    expect(summarizeChecks('abc', [], []).verdict).toBe('none');
  });
});
