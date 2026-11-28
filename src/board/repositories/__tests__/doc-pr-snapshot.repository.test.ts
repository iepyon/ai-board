import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CardId, PullRequestNumber } from '../../../shared/schemas/common.js';
import { createStoreFixture, initializedStore } from '../../../__tests__/store-fixture.js';
import {
  initialDocuments,
  MemoryDocumentStore,
  type DocumentStore,
} from '../../../infrastructure/document-store.js';
import type { PrSnapshot } from '../../models/pr-state.js';
import {
  DocPrSnapshotRepository,
  mergedSnapshotData,
  parsePrSnapshot,
  SNAPSHOTS_COLLECTION,
} from '../doc-pr-snapshot.repository.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-pr-snapshot-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const id = 'refresh-token' as CardId;

function makeSnapshot(overrides: Partial<PrSnapshot['pr']> = {}): PrSnapshot {
  return {
    fingerprint: '[1,"open"]',
    pr: {
      forge: 'github',
      number: 42 as PullRequestNumber,
      state: 'opened',
      draft: true,
      sourceBranch: 'refresh-token',
      title: 'リフレッシュトークン対応',
      webUrl: 'https://github.com/acme/board/pull/42',
      latestNoteAt: '2026-09-04T10:00:00Z',
      noteCount: 3,
      latestAiNoteAt: null,
      latestCommitAt: null,
      mergedAt: null,
      readyAt: null,
      convertedToDraftAt: null,
      ...overrides,
    },
  };
}

function merged(): PrSnapshot {
  return {
    ...makeSnapshot({
      state: 'merged',
      draft: false,
      mergedAt: '2026-09-05T00:00:00Z',
      readyAt: '2026-09-04T09:00:00Z',
    }),
    fingerprint: '[1,"merged"]',
  };
}

function setup(store: DocumentStore = new MemoryDocumentStore(initialDocuments())) {
  const cacheFile = path.join(tmp, 'cache', 'pr-snapshots.json');
  return { store, cacheFile, repository: new DocPrSnapshotRepository(store, cacheFile) };
}

describe('DocPrSnapshotRepository', () => {
  it('開いている PR の控えは使い捨てのファイルに置き、置き場所には書かない', async () => {
    const { store, cacheFile, repository } = setup();

    await repository.save(id, makeSnapshot());

    expect(store.list(SNAPSHOTS_COLLECTION)).toEqual([]);
    expect(fs.existsSync(cacheFile)).toBe(true);
    expect(await repository.findAll()).toEqual(new Map([[id, makeSnapshot()]]));
    expect(await repository.findMerged()).toEqual(new Map());
  });

  it('マージ済みの控えは置き場所に書き、使い捨ての控えから外す', async () => {
    const { store, repository } = setup();
    await repository.save(id, makeSnapshot());

    await repository.save(id, merged());

    expect(store.get(SNAPSHOTS_COLLECTION, id)).toEqual(mergedSnapshotData(merged()));
    expect(await repository.findMerged()).toEqual(new Map([[id, merged()]]));
    expect(await repository.findAll()).toEqual(new Map([[id, merged()]]));
  });

  it('共有の置き場所では、マージ済みの控えを手元に置き、置き場所に書かない', async () => {
    const fixture = createStoreFixture();
    try {
      const store = await initializedStore(fixture);
      const before = fixture.writeLabels();
      const { repository } = setup(store);

      await repository.save(id, merged());
      await repository.save(id, merged());

      expect(fixture.writeLabels()).toEqual(before);
      expect(fs.readdirSync(path.join(fixture.localDir, SNAPSHOTS_COLLECTION))).toEqual([
        `${id}.json`,
      ]);
      expect(await repository.findMerged()).toEqual(new Map([[id, merged()]]));
    } finally {
      fixture.remove();
    }
  });

  it('開いた PR に付け替えたら、前のマージ済みの控えを消す', async () => {
    const { store, repository } = setup();
    await repository.save(id, merged());

    await repository.save(id, makeSnapshot({ number: 43 as PullRequestNumber }));

    expect(store.get(SNAPSHOTS_COLLECTION, id)).toBeNull();
    expect((await repository.findAll()).get(id)?.pr.number).toBe(43);
  });

  it('delete は両方から消す', async () => {
    const { repository } = setup();
    await repository.save(id, merged());
    await repository.save('other' as CardId, makeSnapshot());

    await repository.delete(id);
    await repository.delete('other' as CardId);

    expect(await repository.findAll()).toEqual(new Map());
  });

  it('形の合わない控えと ID として不正な文書は黙って外す', async () => {
    const { store, repository } = setup();
    await store.transact('壊す', () => {
      store.set(SNAPSHOTS_COLLECTION, id, { fingerprint: 1 });
      store.set(SNAPSHOTS_COLLECTION, 'Bad_Id', mergedSnapshotData(merged()));
      return Promise.resolve({ ok: true as const, value: undefined });
    });
    expect(await repository.findAll()).toEqual(new Map());
  });
});

describe('parsePrSnapshot', () => {
  it('latestAiNoteAt を持たない古い控えは null で読む', () => {
    const { latestAiNoteAt: _dropped, ...old } = makeSnapshot().pr;

    const parsed = parsePrSnapshot({ fingerprint: '[1,"open"]', pr: old });

    expect(parsed?.pr.latestAiNoteAt).toBeNull();
    expect(parsed?.pr.noteCount).toBe(3);
  });
});
