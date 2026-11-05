import { describe, expect, it } from 'vitest';
import type { MrSnapshot, MrState } from '../../models/mr-state.js';
import type { CardId, MergeRequestIid } from '../../../shared/schemas/common.js';
import { createSnapshotMrStateProvider } from '../snapshot-mr-state-provider.js';

const mr: MrState = {
  forge: 'github',
  iid: 7 as MergeRequestIid,
  state: 'opened',
  draft: true,
  sourceBranch: 'a',
  title: 'a',
  webUrl: 'https://github.com/acme/board/pull/7',
  latestNoteAt: null,
  noteCount: 0,
  latestAiNoteAt: null,
  latestCommitAt: null,
  mergedAt: null,
  readyAt: null,
  convertedToDraftAt: null,
};

describe('createSnapshotMrStateProvider', () => {
  it('控えにあるカードの PR の状態を返し、無ければ null', () => {
    const snapshots = new Map<CardId, MrSnapshot>([['a' as CardId, { mr, fingerprint: 'x' }]]);
    const provider = createSnapshotMrStateProvider('github', snapshots);

    expect(provider.get('a')).toEqual(mr);
    expect(provider.get('b')).toBeNull();
    expect(provider.connection()).toEqual({ status: 'connected', kind: 'github' });
    expect(provider.failure('a')).toBeNull();
    expect(provider.synced()).toBe(true);
  });

  it('控えが 1 件も無ければ、引き終えたとは言わない', () => {
    expect(createSnapshotMrStateProvider('github', new Map()).synced()).toBe(false);
  });
});
