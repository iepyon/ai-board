import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ForgePoller } from '../forge-poller.js';
import { createCliRunner } from '../cli-runner.js';
import { createDataStore, DATA_BRANCH } from '../data-store.js';
import { FileMrSnapshotRepository } from '../../board/repositories/file-mr-snapshot.repository.js';
import type { CardRepository } from '../../cards/repositories/card.repository.js';
import { ForgeRequestError, type ForgeClient } from '../../board/services/forge-client.js';
import type { CliError } from '../cli-runner.js';
import type { Card } from '../../cards/models/card.js';
import type { MrSnapshot, MrState } from '../../board/models/mr-state.js';
import type { MrSnapshotRepository } from '../../board/repositories/mr-snapshot.repository.js';
import type { CardId, MergeRequestIid } from '../../shared/schemas/common.js';
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

class InMemoryMrSnapshotRepository implements MrSnapshotRepository {
  readonly rows = new Map<CardId, MrSnapshot>();
  saves = 0;

  async findAll(): Promise<Map<CardId, MrSnapshot>> {
    return new Map(this.rows);
  }
  async save(cardId: CardId, snapshot: MrSnapshot): Promise<void> {
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
    mr: null,
    rank: null,
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
    latestAiNoteAt: null,
    latestCommitAt: null,
    mergedAt: null,
    readyAt: null,
    convertedToDraftAt: null,
    ...overrides,
  };
}

/** 指紋は中身から作る。中身が同じなら同じ指紋になる */
function snap(overrides: Partial<MrState> = {}): MrSnapshot {
  const mr = makeMr(overrides);
  return { mr, fingerprint: JSON.stringify(mr) };
}

function failed(httpStatus: number): CliError {
  return { type: 'Failed', command: 'gh', message: '終了コード 1 で失敗した', httpStatus };
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
let snapshots: InMemoryMrSnapshotRepository;

beforeEach(() => {
  onUpdate = vi.fn();
  snapshots = new InMemoryMrSnapshotRepository();
});

// ============================================================
// ポーリング
// ============================================================

describe('ForgePoller', () => {
  it('初回の refresh を終えるまで synced は偽', async () => {
    const repository = new InMemoryCardRepository([makeCard({ mr: 42 as MergeRequestIid })]);
    const poller = new ForgePoller(repository, stubClient({}), snapshots, { onUpdate });

    expect(poller.synced()).toBe(false);
    await poller.refresh();
    expect(poller.synced()).toBe(true);
  });

  it('iid が既知なら iid で問い合わせる', async () => {
    const repository = new InMemoryCardRepository([makeCard({ mr: 42 as MergeRequestIid })]);
    const client = stubClient({ fetchByIid: vi.fn(async () => snap()) });
    const poller = new ForgePoller(repository, client, snapshots, { onUpdate });

    await poller.refresh();

    expect(client.fetchByIid).toHaveBeenCalledWith(42, null);
    expect(client.fetchByBranch).not.toHaveBeenCalled();
    expect(poller.get('refresh-token')?.iid).toBe(42);
  });

  it('iid が無ければブランチから解決し、iid を書き戻す', async () => {
    const repository = new InMemoryCardRepository([makeCard({ branch: 'feat/refresh-token' })]);
    const client = stubClient({ fetchByBranch: vi.fn(async () => snap()) });

    await new ForgePoller(repository, client, snapshots, { onUpdate }).refresh();

    expect(client.fetchByBranch).toHaveBeenCalledWith('feat/refresh-token');
    expect(repository.cards.get('refresh-token')?.mr).toBe(42);
  });

  it('writeMr を渡せば、リポジトリへ直接書かずにそれで書き戻す', async () => {
    const repository = new InMemoryCardRepository([makeCard({ branch: 'feat/refresh-token' })]);
    const client = stubClient({ fetchByBranch: vi.fn(async () => snap()) });
    const writeMr = vi.fn(async () => undefined);

    await new ForgePoller(repository, client, snapshots, { onUpdate, writeMr }).refresh();

    expect(writeMr).toHaveBeenCalledWith('refresh-token', 42);
    expect(repository.cards.get('refresh-token')?.mr).toBeNull();
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
        return snap();
      }),
    });

    await new ForgePoller(repository, client, snapshots, { onUpdate }).refresh();

    expect(repository.cards.get('refresh-token')?.mr).toBe(42);
    expect(repository.cards.get('refresh-token')?.body).toBe('## レビュー\n\n承認');
  });

  it('mr も branch も無いカードは問い合わせない', async () => {
    const client = stubClient();

    await new ForgePoller(new InMemoryCardRepository([makeCard()]), client, snapshots, {
      onUpdate,
    }).refresh();

    expect(client.fetchByIid).not.toHaveBeenCalled();
    expect(client.fetchByBranch).not.toHaveBeenCalled();
  });

  it('状態が変わったときだけ onUpdate を呼ぶ', async () => {
    const repository = new InMemoryCardRepository([makeCard({ mr: 42 as MergeRequestIid })]);
    const client = stubClient({ fetchByIid: vi.fn(async () => snap()) });
    const poller = new ForgePoller(repository, client, snapshots, { onUpdate });

    await poller.refresh();
    expect(onUpdate).toHaveBeenCalledTimes(1);

    await poller.refresh();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('PR の状態が変われば onUpdate を呼ぶ', async () => {
    const repository = new InMemoryCardRepository([makeCard({ mr: 42 as MergeRequestIid })]);
    let state: MrState['state'] = 'opened';
    const client = stubClient({ fetchByIid: vi.fn(async () => snap({ state })) });
    const poller = new ForgePoller(repository, client, snapshots, { onUpdate });

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
    const client = stubClient({ fetchByIid: vi.fn(async () => snap({ draft })) });
    const poller = new ForgePoller(repository, client, snapshots, { onUpdate });

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
      fetchByIid: vi.fn(async () => snap({ draft: true, convertedToDraftAt })),
    });
    const poller = new ForgePoller(repository, client, snapshots, { onUpdate });

    await poller.refresh();
    convertedToDraftAt = '2026-09-05T00:00:00.000Z';
    await poller.refresh();

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(poller.get('refresh-token')?.convertedToDraftAt).toBe('2026-09-05T00:00:00.000Z');
  });

  it('Ready にした時刻が変われば onUpdate を呼ぶ', async () => {
    // 区間の並びは readyAt から PR レビューの区間を始める。取りこぼすと区間の境目が古いまま残る
    const repository = new InMemoryCardRepository([makeCard({ mr: 42 as MergeRequestIid })]);
    let readyAt: string | null = '2026-09-04T00:00:00.000Z';
    const client = stubClient({
      fetchByIid: vi.fn(async () => snap({ readyAt })),
    });
    const poller = new ForgePoller(repository, client, snapshots, { onUpdate });

    await poller.refresh();
    readyAt = '2026-09-05T00:00:00.000Z';
    await poller.refresh();

    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(poller.get('refresh-token')?.readyAt).toBe('2026-09-05T00:00:00.000Z');
  });

  it('取得先が落ちてもキャッシュを保ったまま error 状態にする', async () => {
    const repository = new InMemoryCardRepository([makeCard({ mr: 42 as MergeRequestIid })]);
    let shouldFail = false;
    const client = stubClient({
      fetchByIid: vi.fn(async () => {
        if (shouldFail) throw new Error('ECONNREFUSED');
        return snap();
      }),
    });
    const poller = new ForgePoller(repository, client, snapshots, { onUpdate });

    await poller.refresh();
    expect(poller.connection()).toEqual({ status: 'connected', kind: 'github' });

    shouldFail = true;
    await poller.refresh();

    expect(poller.connection()).toEqual({
      status: 'error',
      kind: 'github',
      message: 'refresh-token: PR #42 の取得に失敗した（ECONNREFUSED）',
    });
    // 直近の値は残す。ボードを空にしない
    expect(poller.get('refresh-token')?.iid).toBe(42);
  });

  it('1 枚の PR だけに効く失敗では接続を止めず、そのカードの失敗として持つ', async () => {
    const repository = new InMemoryCardRepository([
      makeCard({ id: 'a' as CardId, mr: 42 as MergeRequestIid }),
      makeCard({ id: 'b' as CardId, mr: 68 as MergeRequestIid }),
    ]);
    let shouldFail = false;
    const client = stubClient({
      fetchByIid: vi.fn(async (iid) => {
        if (shouldFail && iid === 68) throw new ForgeRequestError('pulls/68', failed(422));
        return snap({ iid });
      }),
    });
    const poller = new ForgePoller(repository, client, snapshots, { onUpdate });

    await poller.refresh();
    shouldFail = true;
    onUpdate.mockClear();
    await poller.refresh();

    expect(poller.connection()).toEqual({ status: 'connected', kind: 'github' });
    expect(poller.failure('b')?.message).toBe('PR #68 の取得（pulls/68）が HTTP 422 で失敗した');
    expect(poller.failure('a')).toBeNull();
    // 前に引けた控えは残す。手前の AI の列に落とさない
    expect(poller.get('b')?.iid).toBe(68);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('失敗が続くあいだは最初の時刻を保ち、引けたら消す', async () => {
    const repository = new InMemoryCardRepository([makeCard({ mr: 68 as MergeRequestIid })]);
    let shouldFail = true;
    const client = stubClient({
      fetchByIid: vi.fn(async () => {
        if (shouldFail) throw new ForgeRequestError('pulls/68', failed(422));
        return snap({ iid: 68 as MergeRequestIid });
      }),
    });
    const poller = new ForgePoller(repository, client, snapshots, { onUpdate });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-05T00:00:00.000Z'));
      await poller.refresh();
      vi.setSystemTime(new Date('2026-11-05T00:05:00.000Z'));
      onUpdate.mockClear();
      await poller.refresh();
    } finally {
      vi.useRealTimers();
    }

    expect(poller.failure('refresh-token')?.since).toBe('2026-11-05T00:00:00.000Z');
    // 同じ失敗が続くだけなら通知しない
    expect(onUpdate).not.toHaveBeenCalled();

    shouldFail = false;
    await poller.refresh();

    expect(poller.failure('refresh-token')).toBeNull();
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('ブランチから解決するときの失敗は、ブランチの名前で伝える', async () => {
    const repository = new InMemoryCardRepository([makeCard({ branch: 'feat/x' })]);
    const client = stubClient({
      fetchByBranch: vi.fn(async () => {
        throw new ForgeRequestError('pulls?head=acme%3Afeat%2Fx', failed(422));
      }),
    });
    const poller = new ForgePoller(repository, client, snapshots);

    await poller.refresh();

    expect(poller.failure('refresh-token')?.message).toBe(
      'ブランチ feat/x の PR の解決（pulls）が HTTP 422 で失敗した'
    );
  });

  it('全体に効く失敗（認証など）は、どのカードのどの問い合わせかを添えて接続を error にする', async () => {
    const repository = new InMemoryCardRepository([makeCard({ mr: 42 as MergeRequestIid })]);
    const client = stubClient({
      fetchByIid: vi.fn(async () => {
        throw new ForgeRequestError('pulls/42', failed(401));
      }),
    });
    const poller = new ForgePoller(repository, client, snapshots);

    await poller.refresh();

    expect(poller.connection()).toEqual({
      status: 'error',
      kind: 'github',
      message: 'refresh-token: PR #42 の取得（pulls/42）が HTTP 401 で失敗した',
    });
    expect(poller.failure('refresh-token')).toBeNull();
  });

  it('問い合わせの対象から外れたカードの失敗を消す', async () => {
    const repository = new InMemoryCardRepository([makeCard({ mr: 68 as MergeRequestIid })]);
    const client = stubClient({
      fetchByIid: vi.fn(async () => {
        throw new ForgeRequestError('pulls/68', failed(422));
      }),
    });
    const poller = new ForgePoller(repository, client, snapshots);

    await poller.refresh();
    expect(poller.failure('refresh-token')).not.toBeNull();

    repository.cards.set('refresh-token', makeCard());
    await poller.refresh();

    expect(poller.failure('refresh-token')).toBeNull();
  });

  it('PR が消えたらキャッシュから外す', async () => {
    const repository = new InMemoryCardRepository([makeCard({ mr: 42 as MergeRequestIid })]);
    let found = true;
    const client = stubClient({ fetchByIid: vi.fn(async () => (found ? snap() : null)) });
    const poller = new ForgePoller(repository, client, snapshots, { onUpdate });

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
          new Promise<MrSnapshot>((resolve) => {
            resolveFetch = () => resolve(snap());
          })
      ),
    });
    const poller = new ForgePoller(repository, client, snapshots, { onUpdate });

    const first = poller.refresh();
    await vi.waitFor(() => expect(client.fetchByIid).toHaveBeenCalledTimes(1));
    await poller.refresh(); // running 中なので即座に戻る

    expect(client.fetchByIid).toHaveBeenCalledTimes(1);

    resolveFetch?.();
    await first;
  });
});

// ============================================================
// 問い合わせを省く
// ============================================================

describe('ForgePoller の問い合わせの省略', () => {
  const card = () => makeCard({ mr: 42 as MergeRequestIid });

  it('マージ済みの PR は 2 回目から問い合わせない', async () => {
    const client = stubClient({ fetchByIid: vi.fn(async () => snap({ state: 'merged' })) });
    const poller = new ForgePoller(new InMemoryCardRepository([card()]), client, snapshots, {
      onUpdate,
    });

    await poller.refresh();
    await poller.refresh();

    expect(client.fetchByIid).toHaveBeenCalledTimes(1);
    expect(poller.get('refresh-token')?.state).toBe('merged');
  });

  it('マージされずに閉じた PR は reopen がありうるので問い合わせ続ける', async () => {
    const client = stubClient({ fetchByIid: vi.fn(async () => snap({ state: 'closed' })) });
    const poller = new ForgePoller(new InMemoryCardRepository([card()]), client, snapshots, {
      onUpdate,
    });

    await poller.refresh();
    await poller.refresh();

    expect(client.fetchByIid).toHaveBeenCalledTimes(2);
  });

  it('カードの番号が控えと違えば、マージ済みでも問い合わせる', async () => {
    snapshots.rows.set(
      'refresh-token' as CardId,
      snap({ state: 'merged', iid: 41 as MergeRequestIid })
    );
    const client = stubClient({ fetchByIid: vi.fn(async () => snap()) });

    await new ForgePoller(new InMemoryCardRepository([card()]), client, snapshots, {
      onUpdate,
    }).refresh();

    expect(client.fetchByIid).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ fingerprint: expect.any(String) })
    );
  });

  it('前回の結果を client に渡す', async () => {
    const client = stubClient({ fetchByIid: vi.fn(async () => snap()) });
    const poller = new ForgePoller(new InMemoryCardRepository([card()]), client, snapshots, {
      onUpdate,
    });

    await poller.refresh();
    await poller.refresh();

    expect(client.fetchByIid).toHaveBeenNthCalledWith(1, 42, null);
    expect(client.fetchByIid).toHaveBeenNthCalledWith(
      2,
      42,
      snapshots.rows.get('refresh-token' as CardId)
    );
  });

  it('client が前回の結果をそのまま返したら、控えを書き直さない', async () => {
    const client = stubClient({
      fetchByIid: vi.fn(async (_iid, previous?: MrSnapshot | null) => previous ?? snap()),
    });
    const poller = new ForgePoller(new InMemoryCardRepository([card()]), client, snapshots, {
      onUpdate,
    });

    await poller.refresh();
    await poller.refresh();

    expect(snapshots.saves).toBe(1);
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('新しいプロセスのポーラーは控えから始め、マージ済みの PR を問い合わせない', async () => {
    // ai-board status は呼ばれるたびに新しいプロセスで 1 度だけ refresh する
    const first = stubClient({ fetchByIid: vi.fn(async () => snap({ state: 'merged' })) });
    await new ForgePoller(new InMemoryCardRepository([card()]), first, snapshots, {
      onUpdate,
    }).refresh();

    const second = stubClient();
    const poller = new ForgePoller(new InMemoryCardRepository([card()]), second, snapshots, {
      onUpdate,
    });
    await poller.refresh();

    expect(second.fetchByIid).not.toHaveBeenCalled();
    expect(poller.get('refresh-token')?.state).toBe('merged');
  });

  it('PR 番号もブランチも外されたカードの控えを消す', async () => {
    const repository = new InMemoryCardRepository([card()]);
    const client = stubClient({ fetchByIid: vi.fn(async () => snap()) });
    const poller = new ForgePoller(repository, client, snapshots, { onUpdate });

    await poller.refresh();
    repository.cards.set('refresh-token', makeCard());
    await poller.refresh();

    expect(poller.get('refresh-token')).toBeNull();
    expect(snapshots.rows.size).toBe(0);
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it('PR が消えたら控えも消す', async () => {
    let found = true;
    const client = stubClient({ fetchByIid: vi.fn(async () => (found ? snap() : null)) });
    const poller = new ForgePoller(new InMemoryCardRepository([card()]), client, snapshots, {
      onUpdate,
    });

    await poller.refresh();
    found = false;
    await poller.refresh();

    expect(snapshots.rows.size).toBe(0);
  });
});

// ============================================================
// 控えの置き場所 — データ用ブランチと使い捨ての JSON
// ============================================================

// 本物の git を何度も走らせるので、既定の 5 秒では遅い CI で足りないことがある
describe('ForgePoller と FileMrSnapshotRepository', { timeout: 30_000 }, () => {
  const card = () => makeCard({ mr: 42 as MergeRequestIid });
  let tmp: string;
  let origin: string;

  function sh(args: readonly string[]): void {
    execFileSync('git', [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  /** clone ごとに親を分ける。使い捨ての控えはデータのワークツリーの親に置かれる */
  function cloneSnapshots(name: string): FileMrSnapshotRepository {
    const dataDir = path.join(tmp, name, 'data');
    fs.mkdirSync(path.dirname(dataDir), { recursive: true });
    sh(['clone', '--quiet', '--branch', DATA_BRANCH, origin, dataDir]);
    const runner = createCliRunner({ timeoutMs: 30_000 });
    return new FileMrSnapshotRepository(createDataStore({ dataDir, runner, lockPollMs: 10 }));
  }

  async function poll(
    repository: FileMrSnapshotRepository,
    client: ForgeClient
  ): Promise<ForgePoller> {
    const poller = new ForgePoller(new InMemoryCardRepository([card()]), client, repository, {
      onUpdate,
    });
    await poller.refresh();
    return poller;
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-forge-poller-'));

    const globalConfig = path.join(tmp, 'gitconfig');
    fs.writeFileSync(globalConfig, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_AUTHOR_NAME', 'ai-board');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'ai-board@example.com');
    vi.stubEnv('GIT_COMMITTER_NAME', 'ai-board');
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'ai-board@example.com');

    origin = path.join(tmp, 'origin.git');
    sh(['init', '--quiet', '--bare', origin]);
    const seed = path.join(tmp, 'seed');
    sh(['clone', '--quiet', origin, seed]);
    sh(['-C', seed, 'checkout', '--quiet', '--orphan', DATA_BRANCH]);
    fs.writeFileSync(path.join(seed, 'ai-board-data.yaml'), 'version: 1\n');
    sh(['-C', seed, 'add', '-A']);
    sh(['-C', seed, 'commit', '--quiet', '-m', 'data: 始める']);
    sh(['-C', seed, 'push', '--quiet', 'origin', `HEAD:refs/heads/${DATA_BRANCH}`]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('マージ済みの PR は、別の clone の新しいポーラーも問い合わせない', async () => {
    // クラウドのセッションは毎回新しい clone から始まる。マージ済みの PR を毎回引き直さない
    await poll(
      cloneSnapshots('a'),
      stubClient({ fetchByIid: vi.fn(async () => snap({ state: 'merged' })) })
    );

    const second = stubClient();
    const poller = await poll(cloneSnapshots('b'), second);

    expect(second.fetchByIid).not.toHaveBeenCalled();
    expect(poller.get('refresh-token')?.state).toBe('merged');
  });

  it('開いている PR は、同じ clone の新しいポーラーは控えから始め、別の clone は引き直す', async () => {
    const opened = snap();
    const local = cloneSnapshots('a');
    await poll(local, stubClient({ fetchByIid: vi.fn(async () => opened) }));

    const same = stubClient({ fetchByIid: vi.fn(async () => opened) });
    await poll(local, same);
    expect(same.fetchByIid).toHaveBeenCalledWith(42, opened);

    const other = stubClient({ fetchByIid: vi.fn(async () => opened) });
    await poll(cloneSnapshots('b'), other);
    expect(other.fetchByIid).toHaveBeenCalledWith(42, null);
  });
});
