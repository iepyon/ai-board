import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '../../../shared/result.js';
import type { CardId, PullRequestNumber } from '../../../shared/schemas/common.js';
import {
  initialDocuments,
  MemoryDocumentStore,
  type DocumentStore,
} from '../../../infrastructure/document-store.js';
import type { Card } from '../../models/card.js';
import { appendReviewEntry } from '../../services/review-log.js';
import {
  CardWriteRefusedError,
  DocCardRepository,
  DocIdeaDividerRepository,
} from '../doc-card.repository.js';

beforeEach(() => {
  // 読み飛ばしの警告でテスト出力を汚さない
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const ID = 'refresh-token' as CardId;

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: ID,
    title: 'リフレッシュトークン対応',
    created: '2026-09-01T00:00:00.000Z',
    startedAt: null,
    skipGates: [],
    branch: null,
    pr: null,
    rank: null,
    body: '',
    ...overrides,
  };
}

function setup(now = '2026-10-01T00:00:00.000Z') {
  const store = new MemoryDocumentStore(initialDocuments());
  const repository = new DocCardRepository(store, { now: () => new Date(now) });
  return { store, repository };
}

/** 書き込みは transact の中で行う */
async function inTx<T>(store: DocumentStore, fn: () => Promise<T>): Promise<T> {
  const result = await store.transact('test', async () => ok(await fn()));
  if (!result.ok) throw new Error('transact failed');
  return result.value;
}

describe('DocCardRepository', () => {
  it('作ったカードを文書に書き、読み戻せる', async () => {
    const { store, repository } = setup();
    const card = makeCard({ body: '## アイデア\n\n本文', branch: 'b', pr: 3 as PullRequestNumber });

    expect(await inTx(store, () => repository.create(card))).toBe(true);

    expect(store.get('cards', ID)).toEqual({
      id: ID,
      title: card.title,
      created: card.created,
      skipGates: [],
      branch: 'b',
      pr: 3,
      body: '## アイデア\n\n本文',
    });
    expect(await repository.findById(ID)).toEqual(card);
    expect(await repository.findAll()).toEqual([card]);
  });

  it('既にある ID は作らない', async () => {
    const { store, repository } = setup();
    await inTx(store, () => repository.create(makeCard()));
    expect(await inTx(store, () => repository.create(makeCard({ title: '別' })))).toBe(false);
    expect((await repository.findById(ID))?.title).toBe('リフレッシュトークン対応');
  });

  it('無いカードの save と appendReview は false', async () => {
    const { store, repository } = setup();
    expect(await inTx(store, () => repository.save(makeCard()))).toBe(false);
    expect(
      await inTx(store, () =>
        repository.appendReview(ID, {
          at: '2026-10-01T00:00:00.000Z',
          gate: 'plan',
          kind: '提出',
          reason: '',
        })
      )
    ).toBe(false);
  });

  it('判断は 1 件 1 文書で足し、本文の ## レビュー に組み立てる', async () => {
    const { store, repository } = setup();
    await inTx(store, () => repository.create(makeCard({ body: '本文' })));
    const entry = {
      at: '2026-10-02T03:04:05.000Z',
      gate: 'plan' as const,
      kind: '提出' as const,
      reason: '判断してほしい点なし',
    };

    await inTx(store, () => repository.appendReview(ID, entry));

    expect(store.get('log', `${ID}.20261002T030405.000Z.plan.submit`)).toEqual({
      cardId: ID,
      at: entry.at,
      gate: 'plan',
      kind: 'submit',
      reason: '判断してほしい点なし',
    });
    expect((await repository.findById(ID))?.body).toBe(appendReviewEntry('本文', entry));
  });

  it('同じミリ秒の同じ判断は連番で足す', async () => {
    const { store, repository } = setup();
    await inTx(store, () => repository.create(makeCard()));
    const entry = {
      at: '2026-10-02T00:00:00.000Z',
      gate: 'plan' as const,
      kind: '提出' as const,
      reason: '',
    };
    await inTx(store, () => repository.appendReview(ID, entry));
    await inTx(store, () => repository.appendReview(ID, entry));
    expect(store.list('log').map((doc) => doc.id)).toEqual([
      `${ID}.20261002T000000.000Z.plan.submit`,
      `${ID}.20261002T000000.000Z.plan.submit-2`,
    ]);
  });

  it('着手は start の判断の文書で持ち、着手を戻すと unstart を足す', async () => {
    const { store, repository } = setup('2026-10-05T00:00:00.000Z');
    await inTx(store, () => repository.create(makeCard()));
    await inTx(store, () => repository.save(makeCard({ startedAt: '2026-10-03T00:00:00.000Z' })));
    expect((await repository.findById(ID))?.startedAt).toBe('2026-10-03T00:00:00.000Z');

    await inTx(store, () => repository.save(makeCard({ startedAt: null })));
    expect((await repository.findById(ID))?.startedAt).toBeNull();
    expect(store.list('log').map((doc) => doc.id)).toEqual([
      `${ID}.20261003T000000.000Z.start.start`,
      `${ID}.20261005T000000.000Z.start.unstart`,
    ]);
  });

  it('本文の保存で判断を変えようとすると拒む', async () => {
    const { store, repository } = setup();
    await inTx(store, () => repository.create(makeCard({ body: '本文' })));
    const changed = appendReviewEntry('本文', {
      at: '2026-10-02T00:00:00.000Z',
      gate: 'plan',
      kind: '承認',
      reason: '',
    });
    await expect(
      inTx(store, () => repository.save(makeCard({ body: changed })))
    ).rejects.toBeInstanceOf(CardWriteRefusedError);
    expect(store.list('log')).toEqual([]);
  });

  it('rank は並び順の文書に書き、ID の順に並べる', async () => {
    const { store, repository } = setup();
    await inTx(store, () => repository.create(makeCard({ id: 'b-card' as CardId, rank: 2 })));
    await inTx(store, () => repository.create(makeCard({ id: 'a-card' as CardId, rank: 5 })));
    expect(store.get('order', 'order')).toEqual({
      divider: null,
      ranks: { 'a-card': 5, 'b-card': 2 },
    });
    expect((await repository.findAll()).map((card) => card.id)).toEqual(['b-card', 'a-card']);
  });

  it('並び順の文書が壊れていれば、rank を変える書き込みを拒み、読むときは空とみなす', async () => {
    const { store, repository } = setup();
    await inTx(store, async () => {
      await repository.create(makeCard());
      store.set('order', 'order', { divider: 'x' });
      return true;
    });
    expect((await repository.findById(ID))?.rank).toBeNull();
    await expect(inTx(store, () => repository.save(makeCard({ rank: 1 })))).rejects.toBeInstanceOf(
      CardWriteRefusedError
    );
  });

  it('読めないカードの文書は読み飛ばし、ほかのカードは読める', async () => {
    const { store, repository } = setup();
    await inTx(store, async () => {
      await repository.create(makeCard({ id: 'good' as CardId }));
      store.set('cards', 'broken', { id: 'broken', title: 1 });
      store.set('cards', 'mismatch', {
        id: 'other',
        title: 'x',
        created: '2026-01-01T00:00:00.000Z',
      });
      return true;
    });
    expect((await repository.findAll()).map((card) => card.id)).toEqual(['good']);
  });

  it('判断の文書が既にある ID には足さない（追記だけ）', async () => {
    const { store, repository } = setup();
    await inTx(store, () => repository.create(makeCard()));
    await inTx(store, async () => {
      store.set('log', `${ID}.20261002T000000.000Z.plan.submit`, { reason: '' });
      return true;
    });
    // 同じ名前は連番になるので、既存の文書は書き換えない
    await inTx(store, () =>
      repository.appendReview(ID, {
        at: '2026-10-02T00:00:00.000Z',
        gate: 'plan',
        kind: '提出',
        reason: 'x',
      })
    );
    expect(store.get('log', `${ID}.20261002T000000.000Z.plan.submit`)).toEqual({ reason: '' });
  });
});

describe('DocIdeaDividerRepository', () => {
  it('区切り線を並び順の文書に読み書きし、rank は変えない', async () => {
    const { store, repository } = setup();
    const divider = new DocIdeaDividerRepository(store);
    await inTx(store, () => repository.create(makeCard({ rank: 3 })));
    expect(await divider.get()).toBeNull();

    await inTx(store, () => divider.set(10));

    expect(await divider.get()).toBe(10);
    expect(store.get('order', 'order')).toEqual({ divider: 10, ranks: { [ID]: 3 } });
  });

  it('並び順の文書が壊れていれば書かない', async () => {
    const { store } = setup();
    const divider = new DocIdeaDividerRepository(store);
    await inTx(store, async () => {
      store.set('order', 'order', { ranks: 'x' });
      return true;
    });
    await expect(inTx(store, () => divider.set(1))).rejects.toBeInstanceOf(CardWriteRefusedError);
  });
});
