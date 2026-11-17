import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CliRunner } from '../../infrastructure/cli-runner.js';
import { createCardDependencies } from '../../cards/composition.js';
import { initialDocuments, MemoryDocumentStore } from '../../infrastructure/document-store.js';
import { ok, err } from '../../shared/result.js';
import type { ForgeConfig } from '../../infrastructure/config.js';
import { PrFetcher } from '../../infrastructure/pr-fetcher.js';
import { createPrStateSource } from '../composition.js';
import type { PrSnapshotRepository } from '../repositories/pr-snapshot.repository.js';
import type { PrSnapshot } from '../models/pr-state.js';
import type { Card } from '../../cards/models/card.js';
import type { CardId, PullRequestNumber } from '../../shared/schemas/common.js';

// ============================================================
// レビュー要求の状態の供給元
// ============================================================

let store: MemoryDocumentStore;

beforeEach(() => {
  store = new MemoryDocumentStore(initialDocuments());
});

/** カードを置き場所に書く（書き込みは transact の中で行う） */
async function createCards(...cards: Card[]): Promise<void> {
  const { cardRepository } = createCardDependencies(store);
  await store.transact('test', async () => {
    for (const card of cards) await cardRepository.create(card);
    return ok(undefined);
  });
}

/** 控えを持たないリポジトリ。ここでは供給元の組み立てだけを確かめる */
const noSnapshots: PrSnapshotRepository = {
  findAll: () => Promise.resolve(new Map()),
  findMerged: () => Promise.resolve(new Map()),
  save: () => Promise.resolve(),
  delete: () => Promise.resolve(),
};

const forge: ForgeConfig = { kind: 'github', owner: 'acme', repo: 'board' };

/** 接続の確かめ（`gh api repos/<owner>/<repo>`）の成否だけを決める偽の CLI */
function authRunner(loggedIn: boolean): CliRunner {
  return {
    run: () =>
      Promise.resolve(
        loggedIn
          ? ok('')
          : err({ type: 'Failed', command: 'gh', message: 'not logged in', httpStatus: null })
      ),
  };
}

describe('createPrStateSource', () => {
  it('取得先が未設定なら、問い合わせずに disabled を返す', async () => {
    const { cardRepository } = createCardDependencies(store);
    const source = await createPrStateSource(null, cardRepository, noSnapshots, authRunner(true));

    expect(source.fetcher).toBeNull();
    expect(source.provider.connection()).toEqual({ status: 'disabled', kind: null, reason: null });
  });

  it('gh が使えなければ、理由付きの disabled を返す', async () => {
    const { cardRepository } = createCardDependencies(store);
    const source = await createPrStateSource(forge, cardRepository, noSnapshots, authRunner(false));

    expect(source.fetcher).toBeNull();
    expect(source.provider.connection()).toMatchObject({ status: 'disabled', kind: 'github' });
    expect(source.provider.connection()).not.toMatchObject({ reason: null });
  });

  it('gh が使えれば、`PrFetcher` を供給元にする', async () => {
    const { cardRepository } = createCardDependencies(store);
    const source = await createPrStateSource(forge, cardRepository, noSnapshots, authRunner(true));

    expect(source.fetcher).toBeInstanceOf(PrFetcher);
    expect(source.provider).toBe(source.fetcher);
    expect(source.provider.connection()).toEqual({ status: 'connected', kind: 'github' });
  });

  describe('gh が使えないとき', () => {
    function card(id: string, pr: number | null): Card {
      return {
        id: id as CardId,
        title: id,
        created: '2026-11-01T00:00:00.000Z',
        startedAt: '2026-11-02T00:00:00.000Z',
        skipGates: [],
        branch: id,
        pr: pr as PullRequestNumber | null,
        rank: null,
        body: '',
      };
    }

    function merged(number: number): PrSnapshot {
      return {
        fingerprint: `[${number}]`,
        pr: {
          forge: 'github',
          number: number as PullRequestNumber,
          state: 'merged',
          draft: false,
          sourceBranch: 'x',
          title: 'x',
          webUrl: `https://github.com/acme/board/pull/${number}`,
          latestNoteAt: null,
          noteCount: 0,
          latestAiNoteAt: null,
          latestCommitAt: null,
          mergedAt: '2026-11-04T00:00:00Z',
          readyAt: '2026-11-03T00:00:00Z',
          convertedToDraftAt: null,
        },
      };
    }

    /** マージ済みの控えの読み方だけを差し替えたリポジトリ */
    function snapshots(findMerged: PrSnapshotRepository['findMerged']): PrSnapshotRepository {
      return { ...noSnapshots, findMerged };
    }

    it('マージ済みの控えのうち、カードの PR 番号と合うものだけを返す', async () => {
      const { cardRepository } = createCardDependencies(store);
      await createCards(card('done', 7), card('renumbered', 9));
      const repository = snapshots(() =>
        Promise.resolve(
          new Map([
            ['done' as CardId, merged(7)],
            ['renumbered' as CardId, merged(8)],
          ])
        )
      );

      const source = await createPrStateSource(
        forge,
        cardRepository,
        repository,
        authRunner(false)
      );

      expect(source.fetcher).toBeNull();
      expect(source.provider.connection()).toMatchObject({ status: 'disabled', kind: 'github' });
      expect(source.provider.get('done')).toEqual(merged(7).pr);
      expect(source.provider.get('renumbered')).toBeNull();
    });

    it('控えを読めなければ、警告してすべて null にする', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const { cardRepository } = createCardDependencies(store);
      await createCards(card('done', 7));
      const repository = snapshots(() => Promise.reject(new Error('壊れた')));

      const source = await createPrStateSource(
        forge,
        cardRepository,
        repository,
        authRunner(false)
      );

      expect(source.provider.get('done')).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('壊れた'));
      warn.mockRestore();
    });
  });
});
