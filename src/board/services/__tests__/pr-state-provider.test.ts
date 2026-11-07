import { describe, it, expect } from 'vitest';
import type { PullRequestNumber } from '../../../shared/schemas/common.js';
import type { PrSnapshot, PrState } from '../../models/pr-state.js';
import { matchMergedSnapshots, unavailablePrStateProvider } from '../pr-state-provider.js';

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
