import { describe, it, expect } from 'vitest';
import type { MergeRequestIid } from '../../../shared/schemas/common.js';
import type { MrSnapshot, MrState } from '../../models/mr-state.js';
import { matchMergedSnapshots, unavailableMrStateProvider } from '../mr-state-provider.js';

// ============================================================
// GitHub に届かないときの供給元と、マージ済みの控えの照らし合わせ
// ============================================================

function mergedPr(iid: number): MrState {
  return {
    forge: 'github',
    iid: iid as MergeRequestIid,
    state: 'merged',
    draft: false,
    sourceBranch: 'done',
    title: 'done',
    webUrl: `https://github.com/acme/board/pull/${iid}`,
    latestNoteAt: null,
    noteCount: 0,
    latestAiNoteAt: null,
    latestCommitAt: null,
    mergedAt: '2026-11-04T00:00:00Z',
    readyAt: '2026-11-03T00:00:00Z',
    convertedToDraftAt: null,
  };
}

function snapshot(iid: number): MrSnapshot {
  return { mr: mergedPr(iid), fingerprint: `[${iid}]` };
}

describe('unavailableMrStateProvider', () => {
  it('渡したマージ済みの PR の状態を返し、無いカードは null', () => {
    const provider = unavailableMrStateProvider(
      'github',
      'gh が無い',
      new Map([['done', mergedPr(7)]])
    );

    expect(provider.get('done')).toEqual(mergedPr(7));
    expect(provider.get('other')).toBeNull();
  });

  it('控えを渡しても、接続は使えないまま・引き終えていないまま', () => {
    const provider = unavailableMrStateProvider(
      'github',
      'gh が無い',
      new Map([['done', mergedPr(7)]])
    );

    expect(provider.connection()).toEqual({
      status: 'disabled',
      kind: 'github',
      reason: 'gh が無い',
    });
    expect(provider.synced()).toBe(false);
    expect(provider.failure('done')).toBeNull();
  });

  it('控えを渡さなければ、すべて null', () => {
    expect(unavailableMrStateProvider('github', 'gh が無い').get('done')).toBeNull();
  });
});

describe('matchMergedSnapshots', () => {
  it('カードの PR 番号と合う控えだけを採る', () => {
    const matched = matchMergedSnapshots(
      [
        { id: 'same', mr: 7 },
        { id: 'renumbered', mr: 9 },
        { id: 'no-mr', mr: null },
      ],
      new Map([
        ['same', snapshot(7)],
        ['renumbered', snapshot(8)],
        ['no-mr', snapshot(10)],
        ['gone', snapshot(11)],
      ])
    );

    expect(matched).toEqual(new Map([['same', mergedPr(7)]]));
  });
});
