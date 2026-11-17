import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { err, ok, type Result } from '../../shared/result.js';
import { ArtifactMirrorStore } from '../../infrastructure/artifact-mirror-store.js';
import {
  initialDocuments,
  MemoryDocumentStore,
  type StoreError,
  type TransactLabel,
} from '../../infrastructure/document-store.js';
import { PrFetcher } from '../../infrastructure/pr-fetcher.js';
import type { ForgeClient } from '../../board/services/forge-client.js';
import type { PrSnapshot, PrState } from '../../board/models/pr-state.js';
import type { PrSnapshotRepository } from '../../board/repositories/pr-snapshot.repository.js';
import type { CardId, PullRequestNumber } from '../../shared/schemas/common.js';
import type { Card } from '../models/card.js';
import { DocCardRepository } from '../repositories/doc-card.repository.js';
import { createTransactionalPrWriter } from '../composition.js';

// ============================================================
// `PrFetcher` の PR 番号の書き戻しを、書き込みの 1 操作に通す
// ============================================================

const CARD_ID = 'refresh-token' as CardId;
const BRANCH = 'feat/refresh-token';
const WRITE_BACK_MESSAGE = `${CARD_ID} の PR 番号を書き戻す`;

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: CARD_ID,
    title: 'リフレッシュトークン対応',
    created: '2026-09-01T00:00:00.000Z',
    startedAt: null,
    skipGates: [],
    branch: BRANCH,
    pr: null,
    rank: null,
    body: '## アイデア\n\nトークンを更新する\n',
    ...overrides,
  };
}

function makePr(): PrState {
  return {
    forge: 'github',
    number: 42 as PullRequestNumber,
    state: 'opened',
    draft: true,
    sourceBranch: BRANCH,
    title: 'PR',
    webUrl: 'https://github.com/acme/board/pull/42',
    latestNoteAt: null,
    noteCount: 0,
    latestAiNoteAt: null,
    latestCommitAt: null,
    mergedAt: null,
    readyAt: null,
    convertedToDraftAt: null,
  };
}

class InMemoryPrSnapshotRepository implements PrSnapshotRepository {
  readonly rows = new Map<CardId, PrSnapshot>();

  async findAll(): Promise<Map<CardId, PrSnapshot>> {
    return new Map(this.rows);
  }
  async findMerged(): Promise<Map<CardId, PrSnapshot>> {
    return new Map([...this.rows].filter(([, snapshot]) => snapshot.pr.state === 'merged'));
  }
  async save(cardId: CardId, snapshot: PrSnapshot): Promise<void> {
    this.rows.set(cardId, snapshot);
  }
  async delete(cardId: CardId): Promise<void> {
    this.rows.delete(cardId);
  }
}

/** ブランチから PR を解決する偽の取得先。解決の前に `beforeResolve` を走らせる */
function branchClient(beforeResolve: () => Promise<void> = async () => undefined): ForgeClient {
  return {
    kind: 'github',
    fetchByNumber: vi.fn(async () => ({ pr: makePr(), fingerprint: 'f' })),
    fetchByBranch: vi.fn(async () => {
      await beforeResolve();
      return { pr: makePr(), fingerprint: 'f' };
    }),
    checkAuth: vi.fn(async () => null),
  };
}

describe('createTransactionalPrWriter', () => {
  let tmp: string;

  /** board/meta とカード 1 枚だけを取り込んだ写し。送る箱は空 */
  async function pulledStore(name: string): Promise<ArtifactMirrorStore> {
    const store = new ArtifactMirrorStore(path.join(tmp, name));
    fs.mkdirSync(path.join(store.mirrorDir, 'board'), { recursive: true });
    fs.writeFileSync(path.join(store.mirrorDir, 'board', 'meta~000001.json'), '{"version":3}');
    await store.transact('始める', () => new DocCardRepository(store).create(makeCard()).then(ok));
    store.ack();
    return store;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-pr-writer-'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('ブランチから解決した PR 番号を、書き込みの 1 操作として送る箱に積む', async () => {
    const store = await pulledStore('a');
    const cards = new DocCardRepository(store);
    const fetcher = new PrFetcher(cards, branchClient(), new InMemoryPrSnapshotRepository(), {
      writePr: createTransactionalPrWriter(store),
    });

    await fetcher.refresh();

    expect(store.outbox().map((batch) => batch.label)).toEqual([WRITE_BACK_MESSAGE]);
    expect((await cards.findById(CARD_ID))?.pr).toBe(42);
    expect(fetcher.connection()).toEqual({ status: 'connected', kind: 'github' });
  });

  it('番号が既に入っていれば、送る箱に積まない', async () => {
    const store = await pulledStore('a');
    const writePr = createTransactionalPrWriter(store);

    await writePr(CARD_ID, 42 as PullRequestNumber);
    const before = store.pendingWrites();
    await writePr(CARD_ID, 42 as PullRequestNumber);

    expect(store.pendingWrites()).toBe(before);
  });

  it('問い合わせ中にほかのプロセスが写しに書いた内容を、書き戻しで消さない', async () => {
    const store = await pulledStore('a');
    const other = new ArtifactMirrorStore(store.storeDir);
    const client = branchClient(async () => {
      // gh api の応答を待つ間に、同じ写しを使う別のプロセスが本文を書いた
      const written = await other.transact('本文を書く', async () => {
        const repository = new DocCardRepository(other);
        const latest = await repository.findById(CARD_ID);
        if (latest === null) return err('missing');
        await repository.save({ ...latest, body: '## アイデア\n\n書き直した\n' });
        return ok(undefined);
      });
      expect(written.ok).toBe(true);
    });

    await new PrFetcher(new DocCardRepository(store), client, new InMemoryPrSnapshotRepository(), {
      writePr: createTransactionalPrWriter(store),
    }).refresh();

    const card = await new DocCardRepository(new ArtifactMirrorStore(store.storeDir)).findById(
      CARD_ID
    );
    expect(card?.pr).toBe(42);
    expect(card?.body).toContain('書き直した');
  });

  it('書き込みに失敗しても例外を投げず、警告して `PrFetcher` の接続を保つ', async () => {
    const store = new MemoryDocumentStore(initialDocuments());
    await store.transact('始める', () => new DocCardRepository(store).create(makeCard()).then(ok));
    const warn = vi.fn();
    const failing = Object.assign(Object.create(store) as MemoryDocumentStore, {
      transact: <T, E>(
        _label: TransactLabel<T>,
        _op: () => Promise<Result<T, E>>
      ): Promise<Result<T, E | StoreError>> =>
        Promise.resolve(err({ type: 'StoreLockTimeout', lockPath: '/x/store.lock' } as const)),
    });
    const fetcher = new PrFetcher(
      new DocCardRepository(store),
      branchClient(),
      new InMemoryPrSnapshotRepository(),
      { writePr: createTransactionalPrWriter(failing, warn) }
    );

    await fetcher.refresh();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('StoreLockTimeout'));
    expect(fetcher.connection()).toEqual({ status: 'connected', kind: 'github' });
    expect(fetcher.get(CARD_ID)?.number).toBe(42);
  });
});
