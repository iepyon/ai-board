import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { err, ok } from '../../shared/result.js';
import { createCliRunner } from '../../infrastructure/cli-runner.js';
import { createDataStore, DATA_BRANCH, type DataStore } from '../../infrastructure/data-store.js';
import { PrFetcher } from '../../infrastructure/pr-fetcher.js';
import type { ForgeClient } from '../../board/services/forge-client.js';
import type { PrSnapshot, PrState } from '../../board/models/pr-state.js';
import type { PrSnapshotRepository } from '../../board/repositories/pr-snapshot.repository.js';
import type { CardId, PullRequestNumber } from '../../shared/schemas/common.js';
import type { Card } from '../models/card.js';
import { FileCardRepository } from '../repositories/file-card.repository.js';
import { createTransactionalPrWriter } from '../composition.js';

// ============================================================
// `PrFetcher` の PR 番号の書き戻しを、書き込みの 1 操作に通す
// ============================================================

const CARD_ID = 'refresh-token' as CardId;
const BRANCH = 'feat/refresh-token';
const WRITE_BACK_MESSAGE = `data: ${CARD_ID} の mr を書き戻す`;

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: CARD_ID,
    title: 'リフレッシュトークン対応',
    created: '2026-09-01T00:00:00.000Z',
    startedAt: null,
    skipGates: [],
    branch: BRANCH,
    mr: null,
    rank: null,
    body: '## アイデア\n\nトークンを更新する\n',
    ...overrides,
  };
}

function makePr(): PrState {
  return {
    forge: 'github',
    iid: 42 as PullRequestNumber,
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
    return new Map([...this.rows].filter(([, snapshot]) => snapshot.mr.state === 'merged'));
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
    fetchByIid: vi.fn(async () => ({ mr: makePr(), fingerprint: 'f' })),
    fetchByBranch: vi.fn(async () => {
      await beforeResolve();
      return { mr: makePr(), fingerprint: 'f' };
    }),
    checkAuth: vi.fn(async () => null),
  };
}

// 本物の git を何度も走らせるので、既定の 5 秒では遅い CI で足りないことがある
describe('createTransactionalPrWriter', { timeout: 30_000 }, () => {
  let tmp: string;
  let origin: string;

  function git(args: readonly string[]): string {
    return execFileSync('git', [...args], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  }

  /** clone ごとに親を分ける。ロックはデータのワークツリーの親に置かれる */
  function cloneStore(name: string): DataStore {
    const dataDir = path.join(tmp, name, 'data');
    fs.mkdirSync(path.dirname(dataDir), { recursive: true });
    git(['clone', '--quiet', '--branch', DATA_BRANCH, origin, dataDir]);
    const runner = createCliRunner({ timeoutMs: 30_000 });
    return createDataStore({ dataDir, runner, lockPollMs: 10 });
  }

  function originLog(): string[] {
    return git(['-C', origin, 'log', '--format=%s', DATA_BRANCH]).trim().split('\n');
  }

  /** origin の最新を、新しい clone で読む */
  async function readFromOrigin(name: string): Promise<Card | null> {
    const store = cloneStore(name);
    return new FileCardRepository(store.dataDir).findById(CARD_ID);
  }

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-mr-writer-'));

    const globalConfig = path.join(tmp, 'gitconfig');
    fs.writeFileSync(globalConfig, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_AUTHOR_NAME', 'ai-board');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'ai-board@example.com');
    vi.stubEnv('GIT_COMMITTER_NAME', 'ai-board');
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'ai-board@example.com');

    origin = path.join(tmp, 'origin.git');
    git(['init', '--quiet', '--bare', origin]);
    const seed = path.join(tmp, 'seed');
    git(['clone', '--quiet', origin, seed]);
    git(['-C', seed, 'checkout', '--quiet', '--orphan', DATA_BRANCH]);
    fs.writeFileSync(path.join(seed, 'ai-board-data.yaml'), 'version: 1\n');
    await new FileCardRepository(seed).create(makeCard());
    git(['-C', seed, 'add', '-A']);
    git(['-C', seed, 'commit', '--quiet', '-m', 'data: 始める']);
    git(['-C', seed, 'push', '--quiet', 'origin', `HEAD:refs/heads/${DATA_BRANCH}`]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('ブランチから解決した PR 番号を、コミットして origin へ push する', async () => {
    const store = cloneStore('a');
    const cards = new FileCardRepository(store.dataDir);
    const fetcher = new PrFetcher(cards, branchClient(), new InMemoryPrSnapshotRepository(), {
      writePr: createTransactionalPrWriter(store),
    });

    await fetcher.refresh();

    expect(originLog()[0]).toBe(WRITE_BACK_MESSAGE);
    expect((await readFromOrigin('b'))?.mr).toBe(42);
    expect(fetcher.connection()).toEqual({ status: 'connected', kind: 'github' });
  });

  it('番号が既に入っていれば、コミットしない', async () => {
    const store = cloneStore('a');
    const writePr = createTransactionalPrWriter(store);

    await writePr(CARD_ID, 42 as PullRequestNumber);
    const before = originLog();
    await writePr(CARD_ID, 42 as PullRequestNumber);

    expect(originLog()).toEqual(before);
  });

  it('問い合わせ中にほかの clone が書いた内容を、書き戻しで消さない', async () => {
    const store = cloneStore('a');
    const other = cloneStore('other');
    const client = branchClient(async () => {
      // gh api の応答を待つ間に、クラウドのセッションが本文を書いて push した
      const written = await other.transact('data: 本文を書く', async (dataDir) => {
        const repository = new FileCardRepository(dataDir);
        const latest = await repository.findById(CARD_ID);
        if (latest === null) return err('missing');
        await repository.save({ ...latest, body: '## アイデア\n\n書き直した\n' });
        return ok(undefined);
      });
      expect(written.ok).toBe(true);
    });

    await new PrFetcher(
      new FileCardRepository(store.dataDir),
      client,
      new InMemoryPrSnapshotRepository(),
      { writePr: createTransactionalPrWriter(store) }
    ).refresh();

    const card = await readFromOrigin('b');
    expect(card?.mr).toBe(42);
    expect(card?.body).toContain('書き直した');
  });

  it('書き込みに失敗しても例外を投げず、警告して `PrFetcher` の接続を保つ', async () => {
    const store = cloneStore('a');
    const warn = vi.fn();
    const failing: Pick<DataStore, 'transact'> = {
      transact: async () =>
        err({ type: 'DataStorePushFailed', attempts: 4, message: 'rejected' } as const),
    };
    const fetcher = new PrFetcher(
      new FileCardRepository(store.dataDir),
      branchClient(),
      new InMemoryPrSnapshotRepository(),
      { writePr: createTransactionalPrWriter(failing, warn) }
    );

    await fetcher.refresh();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('DataStorePushFailed'));
    expect(fetcher.connection()).toEqual({ status: 'connected', kind: 'github' });
    expect(fetcher.get(CARD_ID)?.iid).toBe(42);
  });
});
