import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'node:path';
import { PrFetcher } from '../pr-fetcher.js';
import {
  createStoreFixture,
  initializedStore,
  type StoreFixture,
} from '../../__tests__/store-fixture.js';
import { DocPrSnapshotRepository } from '../../board/repositories/doc-pr-snapshot.repository.js';
import type { CardRepository } from '../../cards/repositories/card.repository.js';
import { ForgeRequestError, type ForgeClient } from '../../board/services/forge-client.js';
import type { CliError } from '../cli-runner.js';
import type { Card } from '../../cards/models/card.js';
import type { PrSnapshot, PrState } from '../../board/models/pr-state.js';
import type { PrSnapshotRepository } from '../../board/repositories/pr-snapshot.repository.js';
import type { CardId, PullRequestNumber } from '../../shared/schemas/common.js';
import type { ReviewEntry } from '../../cards/models/review.js';
import { appendReviewEntry } from '../../cards/services/review-log.js';
import { demoteHeadings } from '../../cards/repositories/card-files.js';

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
  /** ファイルのリポジトリと同じく、理由の中の見出しを下げた判断を本文の `## レビュー` に足す */
  async appendReview(id: CardId, entry: ReviewEntry): Promise<boolean> {
    const card = this.cards.get(id);
    if (card === undefined) return false;
    const reason = demoteHeadings(entry.reason.trim());
    this.cards.set(id, { ...card, body: appendReviewEntry(card.body, { ...entry, reason }) });
    return true;
  }
}

class InMemoryPrSnapshotRepository implements PrSnapshotRepository {
  readonly rows = new Map<CardId, PrSnapshot>();
  saves = 0;

  async findAll(): Promise<Map<CardId, PrSnapshot>> {
    return new Map(this.rows);
  }
  async findMerged(): Promise<Map<CardId, PrSnapshot>> {
    return new Map([...this.rows].filter(([, snapshot]) => snapshot.pr.state === 'merged'));
  }
  async save(cardId: CardId, snapshot: PrSnapshot): Promise<void> {
    this.saves += 1;
    this.rows.set(cardId, snapshot);
  }
  async delete(cardId: CardId): Promise<void> {
    this.rows.delete(cardId);
  }
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'refresh-token' as CardId,
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

function makePr(overrides: Partial<PrState> = {}): PrState {
  return {
    forge: 'github',
    number: 42 as PullRequestNumber,
    state: 'opened',
    draft: false,
    sourceBranch: 'feat/refresh-token',
    title: 'MR',
    webUrl: 'https://github.com/acme/board/pull/42',
    latestNoteAt: null,
    noteCount: 0,
    latestAiNoteAt: null,
    latestCommitAt: null,
    mergedAt: null,
    readyAt: null,
    convertedToDraftAt: null,
    ...overrides,
  };
}

/** 指紋は中身から作る。中身が同じなら同じ指紋になる */
function snap(overrides: Partial<PrState> = {}): PrSnapshot {
  const pr = makePr(overrides);
  return { pr, fingerprint: JSON.stringify(pr) };
}

function failed(httpStatus: number): CliError {
  return { type: 'Failed', command: 'gh', message: '終了コード 1 で失敗した', httpStatus };
}

function stubClient(overrides: Partial<ForgeClient> = {}): ForgeClient {
  return {
    kind: 'github',
    fetchByNumber: vi.fn(async () => null),
    fetchByBranch: vi.fn(async () => null),
    checkAuth: vi.fn(async () => null),
    ...overrides,
  };
}

let snapshots: InMemoryPrSnapshotRepository;

beforeEach(() => {
  snapshots = new InMemoryPrSnapshotRepository();
});

// ============================================================
// ポーリング
// ============================================================

describe('PrFetcher', () => {
  it('初回の refresh を終えるまで synced は偽', async () => {
    const repository = new InMemoryCardRepository([makeCard({ pr: 42 as PullRequestNumber })]);
    const fetcher = new PrFetcher(repository, stubClient({}), snapshots);

    expect(fetcher.synced()).toBe(false);
    await fetcher.refresh();
    expect(fetcher.synced()).toBe(true);
  });

  it('PR 番号が既知なら番号で問い合わせる', async () => {
    const repository = new InMemoryCardRepository([makeCard({ pr: 42 as PullRequestNumber })]);
    const client = stubClient({ fetchByNumber: vi.fn(async () => snap()) });
    const fetcher = new PrFetcher(repository, client, snapshots);

    await fetcher.refresh();

    expect(client.fetchByNumber).toHaveBeenCalledWith(42, null);
    expect(client.fetchByBranch).not.toHaveBeenCalled();
    expect(fetcher.get('refresh-token')?.number).toBe(42);
  });

  it('PR 番号が無ければブランチから解決し、番号を書き戻す', async () => {
    const repository = new InMemoryCardRepository([makeCard({ branch: 'feat/refresh-token' })]);
    const client = stubClient({ fetchByBranch: vi.fn(async () => snap()) });

    await new PrFetcher(repository, client, snapshots).refresh();

    expect(client.fetchByBranch).toHaveBeenCalledWith('feat/refresh-token');
    expect(repository.cards.get('refresh-token')?.pr).toBe(42);
  });

  it('writePr を渡せば、リポジトリへ直接書かずにそれで書き戻す', async () => {
    const repository = new InMemoryCardRepository([makeCard({ branch: 'feat/refresh-token' })]);
    const client = stubClient({ fetchByBranch: vi.fn(async () => snap()) });
    const writePr = vi.fn(async () => undefined);

    await new PrFetcher(repository, client, snapshots, { writePr }).refresh();

    expect(writePr).toHaveBeenCalledWith('refresh-token', 42);
    expect(repository.cards.get('refresh-token')?.pr).toBeNull();
  });

  it('問い合わせ中に人が書いた内容を、書き戻しで上書きしない', async () => {
    const repository = new InMemoryCardRepository([makeCard({ branch: 'feat/refresh-token' })]);
    const client = stubClient({
      fetchByBranch: vi.fn(async () => {
        // gh api の応答を待つ間に、人が ai-board decide で承認した
        const card = repository.cards.get('refresh-token');
        if (card !== undefined) {
          repository.cards.set('refresh-token', { ...card, body: '## レビュー\n\n承認' });
        }
        return snap();
      }),
    });

    await new PrFetcher(repository, client, snapshots).refresh();

    expect(repository.cards.get('refresh-token')?.pr).toBe(42);
    expect(repository.cards.get('refresh-token')?.body).toBe('## レビュー\n\n承認');
  });

  it('pr も branch も無いカードは問い合わせない', async () => {
    const client = stubClient();

    await new PrFetcher(new InMemoryCardRepository([makeCard()]), client, snapshots).refresh();

    expect(client.fetchByNumber).not.toHaveBeenCalled();
    expect(client.fetchByBranch).not.toHaveBeenCalled();
  });

  it('取得先が落ちてもキャッシュを保ったまま error 状態にする', async () => {
    const repository = new InMemoryCardRepository([makeCard({ pr: 42 as PullRequestNumber })]);
    let shouldFail = false;
    const client = stubClient({
      fetchByNumber: vi.fn(async () => {
        if (shouldFail) throw new Error('ECONNREFUSED');
        return snap();
      }),
    });
    const fetcher = new PrFetcher(repository, client, snapshots);

    await fetcher.refresh();
    expect(fetcher.connection()).toEqual({ status: 'connected', kind: 'github' });

    shouldFail = true;
    await fetcher.refresh();

    expect(fetcher.connection()).toEqual({
      status: 'error',
      kind: 'github',
      message: 'refresh-token: PR #42 の取得に失敗した（ECONNREFUSED）',
    });
    // 直近の値は残す。ボードを空にしない
    expect(fetcher.get('refresh-token')?.number).toBe(42);
  });

  it('1 枚の PR だけに効く失敗では接続を止めず、そのカードの失敗として持つ', async () => {
    const repository = new InMemoryCardRepository([
      makeCard({ id: 'a' as CardId, pr: 42 as PullRequestNumber }),
      makeCard({ id: 'b' as CardId, pr: 68 as PullRequestNumber }),
    ]);
    let shouldFail = false;
    const client = stubClient({
      fetchByNumber: vi.fn(async (number) => {
        if (shouldFail && number === 68) throw new ForgeRequestError('pulls/68', failed(422));
        return snap({ number });
      }),
    });
    const fetcher = new PrFetcher(repository, client, snapshots);

    await fetcher.refresh();
    shouldFail = true;
    await fetcher.refresh();

    expect(fetcher.connection()).toEqual({ status: 'connected', kind: 'github' });
    expect(fetcher.failure('b')?.message).toBe('PR #68 の取得（pulls/68）が HTTP 422 で失敗した');
    expect(fetcher.failure('a')).toBeNull();
    // 前に引けた控えは残す。手前の AI の列に落とさない
    expect(fetcher.get('b')?.number).toBe(68);
  });

  it('失敗が続くあいだは最初の時刻を保ち、引けたら消す', async () => {
    const repository = new InMemoryCardRepository([makeCard({ pr: 68 as PullRequestNumber })]);
    let shouldFail = true;
    const client = stubClient({
      fetchByNumber: vi.fn(async () => {
        if (shouldFail) throw new ForgeRequestError('pulls/68', failed(422));
        return snap({ number: 68 as PullRequestNumber });
      }),
    });
    const fetcher = new PrFetcher(repository, client, snapshots);

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-05T00:00:00.000Z'));
      await fetcher.refresh();
      vi.setSystemTime(new Date('2026-11-05T00:05:00.000Z'));
      await fetcher.refresh();
    } finally {
      vi.useRealTimers();
    }

    expect(fetcher.failure('refresh-token')?.since).toBe('2026-11-05T00:00:00.000Z');

    shouldFail = false;
    await fetcher.refresh();

    expect(fetcher.failure('refresh-token')).toBeNull();
  });

  it('ブランチから解決するときの失敗は、ブランチの名前で伝える', async () => {
    const repository = new InMemoryCardRepository([makeCard({ branch: 'feat/x' })]);
    const client = stubClient({
      fetchByBranch: vi.fn(async () => {
        throw new ForgeRequestError('pulls?head=acme%3Afeat%2Fx', failed(422));
      }),
    });
    const fetcher = new PrFetcher(repository, client, snapshots);

    await fetcher.refresh();

    expect(fetcher.failure('refresh-token')?.message).toBe(
      'ブランチ feat/x の PR の解決（pulls）が HTTP 422 で失敗した'
    );
  });

  it('全体に効く失敗（認証など）は、どのカードのどの問い合わせかを添えて接続を error にする', async () => {
    const repository = new InMemoryCardRepository([makeCard({ pr: 42 as PullRequestNumber })]);
    const client = stubClient({
      fetchByNumber: vi.fn(async () => {
        throw new ForgeRequestError('pulls/42', failed(401));
      }),
    });
    const fetcher = new PrFetcher(repository, client, snapshots);

    await fetcher.refresh();

    expect(fetcher.connection()).toEqual({
      status: 'error',
      kind: 'github',
      message: 'refresh-token: PR #42 の取得（pulls/42）が HTTP 401 で失敗した',
    });
    expect(fetcher.failure('refresh-token')).toBeNull();
  });

  it('問い合わせの対象から外れたカードの失敗を消す', async () => {
    const repository = new InMemoryCardRepository([makeCard({ pr: 68 as PullRequestNumber })]);
    const client = stubClient({
      fetchByNumber: vi.fn(async () => {
        throw new ForgeRequestError('pulls/68', failed(422));
      }),
    });
    const fetcher = new PrFetcher(repository, client, snapshots);

    await fetcher.refresh();
    expect(fetcher.failure('refresh-token')).not.toBeNull();

    repository.cards.set('refresh-token', makeCard());
    await fetcher.refresh();

    expect(fetcher.failure('refresh-token')).toBeNull();
  });

  it('PR が消えたらキャッシュから外す', async () => {
    const repository = new InMemoryCardRepository([makeCard({ pr: 42 as PullRequestNumber })]);
    let found = true;
    const client = stubClient({ fetchByNumber: vi.fn(async () => (found ? snap() : null)) });
    const fetcher = new PrFetcher(repository, client, snapshots);

    await fetcher.refresh();
    found = false;
    await fetcher.refresh();

    expect(fetcher.get('refresh-token')).toBeNull();
  });
});

// ============================================================
// 問い合わせを省く
// ============================================================

describe('PrFetcher の問い合わせの省略', () => {
  const card = () => makeCard({ pr: 42 as PullRequestNumber });

  it('マージ済みの PR は 2 回目から問い合わせない', async () => {
    const client = stubClient({ fetchByNumber: vi.fn(async () => snap({ state: 'merged' })) });
    const fetcher = new PrFetcher(new InMemoryCardRepository([card()]), client, snapshots);

    await fetcher.refresh();
    await fetcher.refresh();

    expect(client.fetchByNumber).toHaveBeenCalledTimes(1);
    expect(fetcher.get('refresh-token')?.state).toBe('merged');
  });

  it('マージされずに閉じた PR は reopen がありうるので問い合わせ続ける', async () => {
    const client = stubClient({ fetchByNumber: vi.fn(async () => snap({ state: 'closed' })) });
    const fetcher = new PrFetcher(new InMemoryCardRepository([card()]), client, snapshots);

    await fetcher.refresh();
    await fetcher.refresh();

    expect(client.fetchByNumber).toHaveBeenCalledTimes(2);
  });

  it('カードの番号が控えと違えば、マージ済みでも問い合わせる', async () => {
    snapshots.rows.set(
      'refresh-token' as CardId,
      snap({ state: 'merged', number: 41 as PullRequestNumber })
    );
    const client = stubClient({ fetchByNumber: vi.fn(async () => snap()) });

    await new PrFetcher(new InMemoryCardRepository([card()]), client, snapshots).refresh();

    expect(client.fetchByNumber).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ fingerprint: expect.any(String) })
    );
  });

  it('前回の結果を client に渡す', async () => {
    const client = stubClient({ fetchByNumber: vi.fn(async () => snap()) });
    const fetcher = new PrFetcher(new InMemoryCardRepository([card()]), client, snapshots);

    await fetcher.refresh();
    await fetcher.refresh();

    expect(client.fetchByNumber).toHaveBeenNthCalledWith(1, 42, null);
    expect(client.fetchByNumber).toHaveBeenNthCalledWith(
      2,
      42,
      snapshots.rows.get('refresh-token' as CardId)
    );
  });

  it('client が前回の結果をそのまま返したら、控えを書き直さない', async () => {
    const client = stubClient({
      fetchByNumber: vi.fn(async (_number, previous?: PrSnapshot | null) => previous ?? snap()),
    });
    const fetcher = new PrFetcher(new InMemoryCardRepository([card()]), client, snapshots);

    await fetcher.refresh();
    await fetcher.refresh();

    expect(snapshots.saves).toBe(1);
  });

  it('新しいプロセスの `PrFetcher` は控えから始め、マージ済みの PR を問い合わせない', async () => {
    // ai-board status は呼ばれるたびに新しいプロセスで 1 度だけ refresh する
    const first = stubClient({ fetchByNumber: vi.fn(async () => snap({ state: 'merged' })) });
    await new PrFetcher(new InMemoryCardRepository([card()]), first, snapshots).refresh();

    const second = stubClient();
    const fetcher = new PrFetcher(new InMemoryCardRepository([card()]), second, snapshots);
    await fetcher.refresh();

    expect(second.fetchByNumber).not.toHaveBeenCalled();
    expect(fetcher.get('refresh-token')?.state).toBe('merged');
  });

  describe('中止のカード', () => {
    const aborted = () =>
      makeCard({
        pr: 42 as PullRequestNumber,
        body: appendReviewEntry('', {
          at: '2026-11-05T00:00:00.000Z',
          gate: 'plan',
          kind: '中止',
          reason: '',
        }),
      });

    it('控えがあれば、閉じた PR も 2 回目から問い合わせず、控えを返す', async () => {
      const client = stubClient({ fetchByNumber: vi.fn(async () => snap({ state: 'closed' })) });
      const fetcher = new PrFetcher(new InMemoryCardRepository([aborted()]), client, snapshots);

      await fetcher.refresh();
      await fetcher.refresh();

      expect(client.fetchByNumber).toHaveBeenCalledTimes(1);
      expect(fetcher.get('refresh-token')?.state).toBe('closed');
    });

    it('控えが無ければ一度問い合わせて控えに残す', async () => {
      const client = stubClient({ fetchByNumber: vi.fn(async () => snap({ state: 'closed' })) });

      await new PrFetcher(new InMemoryCardRepository([aborted()]), client, snapshots).refresh();

      expect(client.fetchByNumber).toHaveBeenCalledWith(42, null);
      expect(snapshots.rows.get('refresh-token' as CardId)?.pr.state).toBe('closed');
    });

    it('新しいプロセスの `PrFetcher` は控えから始め、問い合わせず、控えを消さない', async () => {
      snapshots.rows.set('refresh-token' as CardId, snap({ state: 'opened' }));
      const client = stubClient();
      const fetcher = new PrFetcher(new InMemoryCardRepository([aborted()]), client, snapshots);

      await fetcher.refresh();

      expect(client.fetchByNumber).not.toHaveBeenCalled();
      expect(client.fetchByBranch).not.toHaveBeenCalled();
      expect(fetcher.get('refresh-token')?.state).toBe('opened');
      expect(snapshots.rows.has('refresh-token' as CardId)).toBe(true);
    });

    it('控えの番号がカードと違えば問い合わせる', async () => {
      snapshots.rows.set(
        'refresh-token' as CardId,
        snap({ state: 'closed', number: 41 as PullRequestNumber })
      );
      const client = stubClient({ fetchByNumber: vi.fn(async () => snap({ state: 'closed' })) });

      await new PrFetcher(new InMemoryCardRepository([aborted()]), client, snapshots).refresh();

      expect(client.fetchByNumber).toHaveBeenCalledTimes(1);
    });
  });

  it('PR 番号もブランチも外されたカードの控えを消す', async () => {
    const repository = new InMemoryCardRepository([card()]);
    const client = stubClient({ fetchByNumber: vi.fn(async () => snap()) });
    const fetcher = new PrFetcher(repository, client, snapshots);

    await fetcher.refresh();
    repository.cards.set('refresh-token', makeCard());
    await fetcher.refresh();

    expect(fetcher.get('refresh-token')).toBeNull();
    expect(snapshots.rows.size).toBe(0);
  });

  it('PR が消えたら控えも消す', async () => {
    let found = true;
    const client = stubClient({ fetchByNumber: vi.fn(async () => (found ? snap() : null)) });
    const fetcher = new PrFetcher(new InMemoryCardRepository([card()]), client, snapshots);

    await fetcher.refresh();
    found = false;
    await fetcher.refresh();

    expect(snapshots.rows.size).toBe(0);
  });
});

// ============================================================
// 控えの置き場所 — 置き場所の文書と使い捨ての JSON
// ============================================================

describe('PrFetcher と DocPrSnapshotRepository', () => {
  const card = () => makeCard({ pr: 42 as PullRequestNumber });
  let fixture: StoreFixture;

  /** PC ごとの手元のディレクトリで開いた置き場所の控え。同じ名前なら同じ PC */
  async function session(name: string): Promise<DocPrSnapshotRepository> {
    const localDir = path.join(fixture.root, `local-${name}`);
    const store = fixture.open({ localDir });
    const checked = await store.check();
    if (!checked.ok) throw new Error(checked.error.type);
    return new DocPrSnapshotRepository(store, path.join(localDir, 'cache', 'pr-snapshots.json'));
  }

  async function poll(
    repository: DocPrSnapshotRepository,
    client: ForgeClient
  ): Promise<PrFetcher> {
    const fetcher = new PrFetcher(new InMemoryCardRepository([card()]), client, repository);
    await fetcher.refresh();
    return fetcher;
  }

  beforeEach(async () => {
    fixture = createStoreFixture();
    await initializedStore(fixture);
  });

  afterEach(() => {
    fixture.remove();
  });

  it('マージ済みの PR は、同じ PC の新しい `PrFetcher` は問い合わせず、別の PC は 1 度だけ引き直す', async () => {
    // マージ済みの控えは各 PC の手元に置き、共有しない。無ければ GitHub から引き直す
    await poll(
      await session('a'),
      stubClient({ fetchByNumber: vi.fn(async () => snap({ state: 'merged' })) })
    );

    const same = stubClient();
    const fetcher = await poll(await session('a'), same);
    expect(same.fetchByNumber).not.toHaveBeenCalled();
    expect(fetcher.get('refresh-token')?.state).toBe('merged');

    const other = stubClient({ fetchByNumber: vi.fn(async () => snap({ state: 'merged' })) });
    await poll(await session('b'), other);
    expect(other.fetchByNumber).toHaveBeenCalledTimes(1);
  });

  it('開いている PR は、同じ PC の新しい `PrFetcher` は控えから始め、別の PC は引き直す', async () => {
    const opened = snap();
    const local = await session('a');
    await poll(local, stubClient({ fetchByNumber: vi.fn(async () => opened) }));

    const same = stubClient({ fetchByNumber: vi.fn(async () => opened) });
    await poll(await session('a'), same);
    expect(same.fetchByNumber).toHaveBeenCalledWith(42, opened);

    const other = stubClient({ fetchByNumber: vi.fn(async () => opened) });
    await poll(await session('b'), other);
    expect(other.fetchByNumber).toHaveBeenCalledWith(42, null);
  });
});
