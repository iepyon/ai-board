import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ForgePoller } from '../forge-poller.js';
import type { CardRepository } from '../../cards/repositories/card.repository.js';
import type { ForgeClient } from '../../board/services/forge-client.js';
import type { Card } from '../../cards/models/card.js';
import type { MrState } from '../../board/models/mr-state.js';
import type { CardId, MergeRequestIid } from '../../shared/schemas/common.js';

// ============================================================
// テストダブル
// ============================================================

class InMemoryCardRepository implements CardRepository {
  readonly cards = new Map<string, Card>();

  constructor(cards: readonly Card[] = []) {
    for (const card of cards) this.cards.set(card.id, card);
  }

  async findAll(): Promise<Card[]> {
    return [...this.cards.values()];
  }
  async findById(id: CardId): Promise<Card | null> {
    return this.cards.get(id) ?? null;
  }
  async create(card: Card): Promise<boolean> {
    if (this.cards.has(card.id)) return false;
    this.cards.set(card.id, card);
    return true;
  }
  async save(card: Card): Promise<boolean> {
    if (!this.cards.has(card.id)) return false;
    this.cards.set(card.id, card);
    return true;
  }
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'refresh-token' as CardId,
    title: 'リフレッシュトークン対応',
    created: '2026-09-01T00:00:00.000Z',
    explored: false,
    implStartedAt: null,
    change: null,
    branch: null,
    mr: null,
    stageOverride: null,
    body: '',
    ...overrides,
  };
}

function makeMr(overrides: Partial<MrState> = {}): MrState {
  return {
    forge: 'github',
    iid: 42 as MergeRequestIid,
    state: 'opened',
    sourceBranch: 'feat/refresh-token',
    title: 'MR',
    webUrl: 'http://localhost:8080/mr/42',
    latestNoteAt: null,
    noteCount: 0,
    latestCommitAt: null,
    ...overrides,
  };
}

function stubClient(overrides: Partial<ForgeClient> = {}): ForgeClient {
  return {
    kind: 'github',
    fetchByIid: vi.fn(async () => null),
    fetchByBranch: vi.fn(async () => null),
    checkAuth: vi.fn(async () => null),
    ...overrides,
  };
}

let onUpdate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  onUpdate = vi.fn();
});

// ============================================================
// ポーリング
// ============================================================

describe('ForgePoller', () => {
  it('iid が既知なら iid で問い合わせる', async () => {
    const repository = new InMemoryCardRepository([makeCard({ mr: 42 as MergeRequestIid })]);
    const client = stubClient({ fetchByIid: vi.fn(async () => makeMr()) });
    const poller = new ForgePoller(repository, client, { onUpdate });

    await poller.refresh();

    expect(client.fetchByIid).toHaveBeenCalledWith(42);
    expect(client.fetchByBranch).not.toHaveBeenCalled();
    expect(poller.get('refresh-token')?.iid).toBe(42);
  });

  it('iid が無ければブランチから解決し、iid を書き戻す', async () => {
    const repository = new InMemoryCardRepository([makeCard({ branch: 'feat/refresh-token' })]);
    const client = stubClient({ fetchByBranch: vi.fn(async () => makeMr()) });

    await new ForgePoller(repository, client, { onUpdate }).refresh();

    expect(client.fetchByBranch).toHaveBeenCalledWith('feat/refresh-token');
    expect(repository.cards.get('refresh-token')?.mr).toBe(42);
  });

  it('mr も branch も無いカードは問い合わせない', async () => {
    const client = stubClient();

    await new ForgePoller(new InMemoryCardRepository([makeCard()]), client, {
      onUpdate,
    }).refresh();

    expect(client.fetchByIid).not.toHaveBeenCalled();
    expect(client.fetchByBranch).not.toHaveBeenCalled();
  });

  it('状態が変わったときだけ onUpdate を呼ぶ', async () => {
    const repository = new InMemoryCardRepository([makeCard({ mr: 42 as MergeRequestIid })]);
    const client = stubClient({ fetchByIid: vi.fn(async () => makeMr()) });
    const poller = new ForgePoller(repository, client, { onUpdate });

    await poller.refresh();
    expect(onUpdate).toHaveBeenCalledTimes(1);

    await poller.refresh();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('MR の状態が変われば onUpdate を呼ぶ', async () => {
    const repository = new InMemoryCardRepository([makeCard({ mr: 42 as MergeRequestIid })]);
    let state: MrState['state'] = 'opened';
    const client = stubClient({ fetchByIid: vi.fn(async () => makeMr({ state })) });
    const poller = new ForgePoller(repository, client, { onUpdate });

    await poller.refresh();
    state = 'merged';
    await poller.refresh();

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(poller.get('refresh-token')?.state).toBe('merged');
  });

  it('取得先が落ちてもキャッシュを保ったまま error 状態にする', async () => {
    const repository = new InMemoryCardRepository([makeCard({ mr: 42 as MergeRequestIid })]);
    let shouldFail = false;
    const client = stubClient({
      fetchByIid: vi.fn(async () => {
        if (shouldFail) throw new Error('ECONNREFUSED');
        return makeMr();
      }),
    });
    const poller = new ForgePoller(repository, client, { onUpdate });

    await poller.refresh();
    expect(poller.connection()).toEqual({ status: 'connected', kind: 'github' });

    shouldFail = true;
    await poller.refresh();

    expect(poller.connection()).toEqual({
      status: 'error',
      kind: 'github',
      message: 'ECONNREFUSED',
    });
    // 直近の値は残す。ボードを空にしない
    expect(poller.get('refresh-token')?.iid).toBe(42);
  });

  it('MR が消えたらキャッシュから外す', async () => {
    const repository = new InMemoryCardRepository([makeCard({ mr: 42 as MergeRequestIid })]);
    let found = true;
    const client = stubClient({ fetchByIid: vi.fn(async () => (found ? makeMr() : null)) });
    const poller = new ForgePoller(repository, client, { onUpdate });

    await poller.refresh();
    found = false;
    await poller.refresh();

    expect(poller.get('refresh-token')).toBeNull();
  });

  it('前回の実行が終わるまで次の refresh を走らせない', async () => {
    const repository = new InMemoryCardRepository([makeCard({ mr: 42 as MergeRequestIid })]);
    let resolveFetch: (() => void) | null = null;
    const client = stubClient({
      fetchByIid: vi.fn(
        () =>
          new Promise<MrState>((resolve) => {
            resolveFetch = () => resolve(makeMr());
          })
      ),
    });
    const poller = new ForgePoller(repository, client, { onUpdate });

    const first = poller.refresh();
    await poller.refresh(); // running 中なので即座に戻る

    expect(client.fetchByIid).toHaveBeenCalledTimes(1);

    resolveFetch?.();
    await first;
  });
});
