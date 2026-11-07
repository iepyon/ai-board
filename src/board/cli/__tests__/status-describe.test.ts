import { describe, expect, it } from 'vitest';
import type { ForgeConnection } from '../../models/mr-state.js';
import type { NextAction } from '../../services/next-action.js';
import { describeForge, describeNext } from '../status-describe.js';

const CONNECTED: ForgeConnection = { status: 'connected', kind: 'github' };
const UNSET: ForgeConnection = { status: 'disabled', kind: null, reason: null };
const UNAVAILABLE: ForgeConnection = { status: 'disabled', kind: 'github', reason: 'gh が無い' };

function next(overrides: Partial<NextAction>): NextAction {
  return {
    cardId: 'c',
    action: 'implement',
    reason: '計画が承認されている',
    step: null,
    ...overrides,
  };
}

describe('describeNext', () => {
  it('implement の手では段を添える', () => {
    expect(describeNext(next({ step: 'task' }), CONNECTED)).toBe(
      'implement c 段=task（計画が承認されている）'
    );
    expect(describeNext(next({ step: 'review' }), CONNECTED)).toBe(
      'implement c 段=review（計画が承認されている）'
    );
    expect(describeNext(next({ step: 'close' }), CONNECTED)).toBe(
      'implement c 段=close（計画が承認されている）'
    );
  });

  it('implement で段を読めなかったときは 不明 と出す', () => {
    expect(describeNext(next({ step: null }), CONNECTED)).toBe(
      'implement c 段=不明（計画が承認されている）'
    );
  });

  it('implement 以外の手では段を出さない', () => {
    expect(describeNext(next({ action: 'plan', reason: '着手された' }), CONNECTED)).toBe(
      'plan c（着手された）'
    );
  });

  it('次の一手が無ければ、GitHub が接続済みか未設定かで理由を分ける', () => {
    expect(describeNext(null, CONNECTED)).toBe('なし（AI が進められるカードはありません）');
    expect(describeNext(null, UNSET)).toBe('なし（AI が進められるカードはありません）');
    expect(describeNext(null, UNAVAILABLE)).toBe(
      'なし（GitHub に接続できないため、ループは止まります）'
    );
    expect(describeNext(null, { status: 'error', kind: 'github', message: '失敗' })).toBe(
      'なし（GitHub に接続できないため、ループは止まります）'
    );
  });
});

describe('describeForge', () => {
  it('未設定は github: が無いことで見分け、使えないときは理由を出す', () => {
    expect(describeForge(CONNECTED)).toBe('接続済み');
    expect(describeForge(UNSET)).toBe('未設定');
    expect(describeForge(UNAVAILABLE)).toBe('使えません（gh が無い）');
  });
});
