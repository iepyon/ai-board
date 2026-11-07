import { describe, it, expect } from 'vitest';
import type { PullRequestNumber } from '../../../shared/schemas/common.js';
import type { PrSnapshot, PrState } from '../../models/pr-state.js';
import {
  isFrozen,
  matchMergedSnapshots,
  unavailablePrStateProvider,
} from '../pr-state-provider.js';

// ============================================================
// GitHub に届かないときの供給元と、マージ済みの控えの照らし合わせ
// ============================================================

function mergedPr(number: number): PrState {
  return {
    forge: 'github',
    number: number as PullRequestNumber,
    state: 'merged',
    draft: false,
    sourceBranch: 'done',
    title: 'done',
    webUrl: `https://github.com/acme/board/pull/${number}`,
    latestNoteAt: null,
    noteCount: 0,
    latestAiNoteAt: null,
    latestCommitAt: null,
    mergedAt: '2026-11-04T00:00:00Z',
    readyAt: '2026-11-03T00:00:00Z',
    convertedToDraftAt: null,
  };
}

function snapshot(number: number): PrSnapshot {
  return { pr: mergedPr(number), fingerprint: `[${number}]` };
}

describe('unavailablePrStateProvider', () => {
  it('渡したマージ済みの PR の状態だけを返し、接続は使えないまま・引き終えていないまま', () => {
    const provider = unavailablePrStateProvider(
      'github',
      'gh が無い',
      new Map([['done', mergedPr(7)]])
    );

    expect(provider.get('done')).toEqual(mergedPr(7));
    expect(provider.get('other')).toBeNull();
    expect(provider.connection()).toEqual({
      status: 'disabled',
      kind: 'github',
      reason: 'gh が無い',
    });
    expect(provider.synced()).toBe(false);
    expect(provider.failure('done')).toBeNull();
  });

  it('控えを渡さなければ、すべて null', () => {
    expect(unavailablePrStateProvider('github', 'gh が無い').get('done')).toBeNull();
  });
});

describe('matchMergedSnapshots', () => {
  it('カードの PR 番号と合う控えだけを採る', () => {
    const matched = matchMergedSnapshots(
      [
        { id: 'same', pr: 7 },
        { id: 'renumbered', pr: 9 },
        { id: 'no-pr', pr: null },
      ],
      new Map([
        ['same', snapshot(7)],
        ['renumbered', snapshot(8)],
        ['no-pr', snapshot(10)],
        ['gone', snapshot(11)],
      ])
    );

    expect(matched).toEqual(new Map([['same', mergedPr(7)]]));
  });
});

describe('isFrozen', () => {
  const log = (...kinds: string[]): string =>
    `## レビュー\n\n${kinds
      .map((kind, i) => `### 2026-11-03T0${i}:00:00.000Z plan ${kind}\n\n理由\n`)
      .join('\n')}`;

  it('最新が 中止 で、控えの番号がカードと合えば真', () => {
    expect(isFrozen({ pr: 7, body: log('提出', '中止') }, snapshot(7))).toBe(true);
  });

  it('中止でなければ偽', () => {
    expect(isFrozen({ pr: 7, body: '' }, snapshot(7))).toBe(false);
    expect(isFrozen({ pr: 7, body: log('提出') }, snapshot(7))).toBe(false);
  });

  it('中止の後に別の判断が書かれ、最新が 中止 でなくなれば偽', () => {
    expect(isFrozen({ pr: 7, body: log('中止', '提出') }, snapshot(7))).toBe(false);
  });

  it('控えが無い・番号が違えば偽', () => {
    expect(isFrozen({ pr: 7, body: log('中止') }, null)).toBe(false);
    expect(isFrozen({ pr: 8, body: log('中止') }, snapshot(7))).toBe(false);
    expect(isFrozen({ pr: null, body: log('中止') }, snapshot(7))).toBe(false);
  });
});
