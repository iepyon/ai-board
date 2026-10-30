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
    draft: false,
    sourceBranch: 'feat/refresh-token',
    title: 'MR',
    webUrl: 'https://github.com/acme/board/pull/42',
    latestNoteAt: null,
    noteCount: 0,
    latestCommitAt: null,
    mergedAt: null,
    convertedToDraftAt: null,
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

  it('問い合わせ中に人が書いた内容を、書き戻しで上書きしない', async () => {
    const repository = new InMemoryCardRepository([makeCard({ branch: 'feat/refresh-token' })]);
    const client = stubClient({
      fetchByBranch: vi.fn(async () => {
        // gh api の応答を待つ間に、人が画面で承認した
        const card = repository.cards.get('refresh-token');
        if (card !== undefined) {
          repository.cards.set('refresh-token', { ...card, body: '## レビュー\n\n承認' });
        }
        return makeMr();
      }),
    });

    await new ForgePoller(repository, client, { onUpdate }).refresh();

    expect(repository.cards.get('refresh-token')?.mr).toBe(42);
    expect(repository.cards.get('refresh-token')?.body).toBe('## レビュー\n\n承認');
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

  it('PR の状態が変われば onUpdate を呼ぶ', async () => {
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

  it('Draft から Ready にすれば onUpdate を呼ぶ', async () => {
    // 計画レビューから PR中 へ進む合図なので、取りこぼすと列が動かない
    const repository = new InMemoryCardRepository([makeCard({ mr: 42 as MergeRequestIid })]);
    let draft = true;
    const client = stubClient({ fetchByIid: vi.fn(async () => makeMr({ draft })) });
    const poller = new ForgePoller(repository, client, { onUpdate });

    await poller.refresh();
    draft = false;
    await poller.refresh();

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(poller.get('refresh-token')?.draft).toBe(false);
  });

  it('Draft に戻された時刻が変われば onUpdate を呼ぶ', async () => {
    // 人が PR を Draft に戻したことは止まりの判定に効く。取りこぼすとループが Ready にし直す
    const repository = new InMemoryCardRepository([makeCard({ mr: 42 as MergeRequestIid })]);
    let convertedToDraftAt: string | null = null;
    const client = stubClient({
      fetchByIid: vi.fn(async () => makeMr({ draft: true, convertedToDraftAt })),
    });
    const poller = new ForgePoller(repository, client, { onUpdate });

    await poller.refresh();
    convertedToDraftAt = '2026-09-05T00:00:00.000Z';
    await poller.refresh();

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(poller.get('refresh-token')?.convertedToDraftAt).toBe('2026-09-05T00:00:00.000Z');
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

  it('PR が消えたらキャッシュから外す', async () => {
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
