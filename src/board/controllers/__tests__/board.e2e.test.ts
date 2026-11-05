import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Application } from 'express';
import { createApp } from '../../../app.js';
import {
  createFileCardDependencies,
  createTransactionalCardDependencies,
  type CardDependencies,
} from '../../../cards/composition.js';
import { createBoardDependencies, createLoopHistoryRepository } from '../../composition.js';
import { writeLoopFinish, writeLoopStart } from '../../repositories/loop-history.repository.js';
import type { MrStateProvider } from '../../services/mr-state-provider.js';
import type { MrState } from '../../models/mr-state.js';
import type { CardId, MergeRequestIid } from '../../../shared/schemas/common.js';
import { createCliRunner } from '../../../infrastructure/cli-runner.js';
import {
  createDataStore,
  DATA_BRANCH,
  type DataStore,
} from '../../../infrastructure/data-store.js';
import { parseCard } from '../../../cards/repositories/card-markdown.js';
import { REVIEW_HEADING, parseReviewLog } from '../../../cards/services/review-log.js';
import type { Card } from '../../../cards/models/card.js';
import { isErr, ok } from '../../../shared/result.js';

// ============================================================
// テスト用プロジェクトの組み立て
//
// カードは、一時ディレクトリの bare リポジトリを origin にしたデータ用ブランチの clone に置く。
// 画面の書き込みは本物の git で取り直し・コミット・push を通る。
// ============================================================

let tmp: string;
let root: string;
let origin: string;
let store: DataStore;
/** 準備と読み出しに使う、transact を通さないカードの依存 */
let files: CardDependencies;

const runner = createCliRunner({ timeoutMs: 30_000 });

// 書き込みのたびに本物の git で fetch・commit・push が走るので、既定の 5 秒では足りないことがある
vi.setConfig({ testTimeout: 30_000 });

function sh(args: readonly string[]): string {
  return execFileSync('git', [...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function git(cwd: string, ...args: string[]): string {
  return sh(['-C', cwd, ...args]).trim();
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-e2e-'));
  root = path.join(tmp, 'project');
  await fs.mkdir(root);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  // 利用者の git の設定（署名など）に左右されないよう、空の設定と名前を与える
  const globalConfig = path.join(tmp, 'gitconfig');
  await fs.writeFile(globalConfig, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_AUTHOR_NAME', 'ai-board');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'ai-board@example.com');
  vi.stubEnv('GIT_COMMITTER_NAME', 'ai-board');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'ai-board@example.com');

  origin = path.join(tmp, 'origin.git');
  sh(['init', '--quiet', '--bare', origin]);

  const seedDir = path.join(tmp, 'seed');
  sh(['clone', '--quiet', origin, seedDir]);
  git(seedDir, 'checkout', '--quiet', '--orphan', DATA_BRANCH);
  await fs.writeFile(path.join(seedDir, 'ai-board-data.yaml'), 'version: 1\n');
  git(seedDir, 'add', '-A');
  git(seedDir, 'commit', '--quiet', '-m', 'data: 始める');
  git(seedDir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${DATA_BRANCH}`);

  // 手元と同じく .ai-board/data/ に置く。ロックはその親（.ai-board/）に作られる
  const dataDir = path.join(root, '.ai-board', 'data');
  await fs.mkdir(path.dirname(dataDir), { recursive: true });
  sh(['clone', '--quiet', '--branch', DATA_BRANCH, origin, dataDir]);

  store = createDataStore({ dataDir, runner, lockPollMs: 10 });
  files = createFileCardDependencies(dataDir);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function writeFile(relativePath: string, content: string): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf-8');
}

/**
 * カードを Markdown で書いてデータ用ブランチに入れる。移行前のカードファイルと同じ書式で用意できる。
 *
 * 本文の `## レビュー` の判断は、元の時刻のまま 1 件ずつ追記する
 * （新しいカードの本文に判断があると、ファイルのリポジトリは書かずに拒む）。
 * 直に書くと次の書き込みの取り直しで消えるので、transact を通して origin へ push する。
 */
async function writeCard(id: string, content: string): Promise<void> {
  const card = parseCard(`${id}.md`, content);
  if (card === null) throw new Error(`テスト用のカードが読めません: ${id}`);

  const index = card.body.indexOf(REVIEW_HEADING);
  const prose = index === -1 ? card.body : card.body.slice(0, index).replace(/\n+$/, '');

  const result = await store.transact('data: テストの準備', async () => {
    if (!(await files.cardRepository.create({ ...card, body: prose }))) {
      throw new Error(`テスト用のカードを作れません: ${id}`);
    }

    for (const entry of parseReviewLog(card.body)) {
      const appended = await files.appendReviewCommand({
        id: card.id,
        gate: entry.gate,
        kind: entry.kind,
        reason: entry.reason,
        at: new Date(entry.at),
      });
      if (isErr(appended)) return appended;
    }
    return ok(undefined);
  });
  if (isErr(result)) throw new Error(`準備に失敗しました: ${JSON.stringify(result.error)}`);
}

async function readCard(id: string): Promise<Card | null> {
  return files.cardRepository.findById(id as CardId);
}

/** origin のデータ用ブランチのコミットの件名。新しい順 */
function originLog(): string[] {
  return git(origin, 'log', '--format=%s', DATA_BRANCH).split('\n');
}

function stubMrProvider(states: Record<string, MrState> = {}): MrStateProvider {
  return {
    get: (cardId) => states[cardId] ?? null,
    connection: () => ({ status: 'connected', kind: 'github' }),
    synced: () => true,
  };
}

function buildApp(mrProvider?: MrStateProvider): Application {
  const cards = createTransactionalCardDependencies(store);
  const board = createBoardDependencies(
    path.join(root, '.ai-board', 'plans'),
    cards.cardRepository,
    cards.ideaDividerRepository,
    mrProvider,
    createLoopHistoryRepository(store.dataDir)
  );

  // フロントエンドの静的配信は e2e の対象外
  return createApp({ cards, board, webDir: undefined });
}

// ============================================================
// GET /api/board
// ============================================================

describe('GET /api/board', () => {
  it('カードが 1 枚も無ければ空のボードを返す', async () => {
    const response = await request(buildApp()).get('/api/board').expect(200);

    expect(response.body.cards).toEqual([]);
    expect(response.body.stages).toEqual([
      'idea',
      'planning',
      'plan-review',
      'impling',
      'pr',
      'merged',
    ]);
    expect(response.body.forge).toEqual({ status: 'disabled', kind: null, reason: null });
  });

  it('計画ファイルの実態からステージを導出する', async () => {
    await writeCard(
      'refresh-token',
      '---\nid: refresh-token\ntitle: リフレッシュトークン対応\n---\n'
    );
    await writeFile('.ai-board/plans/refresh-token.md', '# 計画\n\n- [x] 1.1 done\n- [ ] 1.2 todo');

    const response = await request(buildApp()).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.stage).toBe('plan-review');
    expect(card.plan.tasks).toEqual({ completed: 1, total: 2 });
    expect(card.plan.archived).toBe(false);
  });

  it('archive された計画は merged になる', async () => {
    await writeCard('login-redesign', '---\nid: login-redesign\ntitle: ログイン画面刷新\n---\n');
    await writeFile('.ai-board/plans/archive/login-redesign.md', '# 済んだ計画');

    const response = await request(buildApp()).get('/api/board').expect(200);

    expect(response.body.cards[0].stage).toBe('merged');
    expect(response.body.cards[0].plan.archived).toBe(true);
  });

  it('本文と判断を分けて返す: body に ## レビュー は無く、reviews に判断が書かれた順で並ぶ', async () => {
    await writeCard(
      'split',
      [
        '---',
        'id: split',
        'title: 分ける',
        '---',
        '## アイデア',
        '',
        'なにかする。',
        '',
        '## 探索メモ',
        '',
        '- 調べた',
        '',
        '## レビュー',
        '',
        '### 2026-09-05T00:00:00.000Z plan 提出',
        '',
        '見てほしい',
        '',
        '### 2026-09-06T00:00:00.000Z plan 否決',
        '',
        '浅い',
      ].join('\n')
    );

    const response = await request(buildApp()).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.body).toBe('## アイデア\n\nなにかする。\n\n## 探索メモ\n\n- 調べた');
    expect(card.reviews).toEqual([
      { at: '2026-09-05T00:00:00.000Z', gate: 'plan', kind: '提出', reason: '見てほしい' },
      { at: '2026-09-06T00:00:00.000Z', gate: 'plan', kind: '否決', reason: '浅い' },
    ]);
  });

  it('ボードのレスポンスに計画の本文は含めない', async () => {
    // 計画 1 本はカード本文より桁違いに大きく、SSE のたびに引き直される。
    // 本文は詳細パネルを開いたときだけ取りに行く。
    await writeCard('heavy', '---\nid: heavy\ntitle: 重い\n---\n');
    await writeFile('.ai-board/plans/heavy.md', '# 計画\n\nここに長い本文が入る');

    const response = await request(buildApp()).get('/api/board').expect(200);

    expect(response.body.cards[0].plan).toEqual({
      tasks: { completed: 0, total: 0 },
      archived: false,
      updatedAt: expect.any(String),
    });
    expect(JSON.stringify(response.body)).not.toContain('ここに長い本文が入る');
  });

  it('PR の状態を反映する', async () => {
    await writeCard('s3-upload', '---\nid: s3-upload\ntitle: S3 アップロード\nmr: 38\n---\n');

    const mr: MrState = {
      forge: 'github',
      iid: 38 as MergeRequestIid,
      state: 'opened',
      draft: false,
      sourceBranch: 'feat/s3',
      title: 'S3 アップロード',
      webUrl: 'https://github.com/acme/board/pull/38',
      latestNoteAt: '2026-09-04T10:00:00.000Z',
      noteCount: 1,
      latestCommitAt: '2026-09-04T10:30:00.000Z',
      mergedAt: null,
      readyAt: '2026-09-04T09:00:00.000Z',
      convertedToDraftAt: null,
    };

    const response = await request(buildApp(stubMrProvider({ 's3-upload': mr })))
      .get('/api/board')
      .expect(200);

    expect(response.body.cards[0].stage).toBe('pr');
    expect(response.body.cards[0].mrState.resubmitted).toBe(true);
    expect(response.body.cards[0].mrState.webUrl).toBe('https://github.com/acme/board/pull/38');
    expect(response.body.forge).toEqual({ status: 'connected', kind: 'github' });
  });

  it('計画ファイルの mtime を plan.updatedAt として返す', async () => {
    await writeCard('dated', '---\nid: dated\ntitle: 日付\n---\n');
    await writeFile('.ai-board/plans/dated.md', '- [ ] 1');
    const mtime = new Date('2026-09-20T01:02:03.000Z');
    await fs.utimes(path.join(root, '.ai-board/plans/dated.md'), mtime, mtime);

    const response = await request(buildApp()).get('/api/board').expect(200);

    expect(response.body.cards[0].plan.updatedAt).toBe('2026-09-20T01:02:03.000Z');
  });

  it('マージ済みの PR は mrState.mergedAt に日時を持つ', async () => {
    await writeCard('shipped', '---\nid: shipped\ntitle: 出荷\nmr: 40\n---\n');

    const mr: MrState = {
      forge: 'github',
      iid: 40 as MergeRequestIid,
      state: 'merged',
      sourceBranch: 'feat/shipped',
      title: '出荷',
      webUrl: 'https://github.com/acme/board/pull/40',
      latestNoteAt: null,
      noteCount: 0,
      latestCommitAt: null,
      mergedAt: '2026-09-25T03:00:00.000Z',
      readyAt: '2026-09-25T00:00:00.000Z',
      convertedToDraftAt: null,
    };

    const response = await request(buildApp(stubMrProvider({ shipped: mr })))
      .get('/api/board')
      .expect(200);

    expect(response.body.cards[0].stage).toBe('merged');
    expect(response.body.cards[0].mrState.mergedAt).toBe('2026-09-25T03:00:00.000Z');
    expect(response.body.cards[0].mrState.readyAt).toBe('2026-09-25T00:00:00.000Z');
  });

  it('カードが各工程にいた区間の並びを timeline に載せる', async () => {
    await writeCard(
      'traced',
      [
        '---',
        'id: traced',
        'title: 区間',
        "created: '2026-09-01T00:00:00.000Z'",
        "startedAt: '2026-09-02T00:00:00.000Z'",
        'mr: 41',
        '---',
        '',
        '## レビュー',
        '',
        '### 2026-09-03T00:00:00.000Z plan 提出',
        '',
        '### 2026-09-04T00:00:00.000Z plan 否決',
        '',
        '### 2026-09-05T00:00:00.000Z plan 再提出',
        '',
        '### 2026-09-06T00:00:00.000Z plan 承認',
        '',
        '### 2026-09-07T00:00:00.000Z verify 提出',
        '',
        '### 2026-09-08T00:00:00.000Z verify 承認',
        '',
      ].join('\n')
    );
    await writeCard(
      'fresh-idea',
      "---\nid: fresh-idea\ntitle: アイデア\ncreated: '2026-09-01T00:00:00.000Z'\n---\n"
    );

    const mr: MrState = {
      forge: 'github',
      iid: 41 as MergeRequestIid,
      state: 'merged',
      draft: false,
      sourceBranch: 'traced',
      title: '区間',
      webUrl: 'https://github.com/acme/board/pull/41',
      latestNoteAt: null,
      noteCount: 0,
      latestCommitAt: null,
      mergedAt: '2026-09-10T00:00:00.000Z',
      readyAt: '2026-09-09T00:00:00.000Z',
      convertedToDraftAt: null,
    };

    const response = await request(buildApp(stubMrProvider({ traced: mr })))
      .get('/api/board')
      .expect(200);
    const byId = new Map(
      (response.body.cards as { id: string; timeline: unknown }[]).map((card) => [card.id, card])
    );

    expect(byId.get('traced')?.timeline).toEqual([
      {
        kind: 'idea',
        owner: 'human',
        start: '2026-09-01T00:00:00.000Z',
        end: '2026-09-02T00:00:00.000Z',
        phases: [],
      },
      {
        kind: 'planning',
        owner: 'ai',
        start: '2026-09-02T00:00:00.000Z',
        end: '2026-09-03T00:00:00.000Z',
        phases: [],
      },
      {
        kind: 'plan-review',
        owner: 'human',
        start: '2026-09-03T00:00:00.000Z',
        end: '2026-09-04T00:00:00.000Z',
        phases: [],
      },
      {
        kind: 'plan-rework',
        owner: 'ai',
        start: '2026-09-04T00:00:00.000Z',
        end: '2026-09-05T00:00:00.000Z',
        phases: [],
      },
      {
        kind: 'plan-review',
        owner: 'human',
        start: '2026-09-05T00:00:00.000Z',
        end: '2026-09-06T00:00:00.000Z',
        phases: [],
      },
      // 廃止した verify のエントリは読まないので、実装は Ready まで 1 区間で続く
      {
        kind: 'implementing',
        owner: 'ai',
        start: '2026-09-06T00:00:00.000Z',
        end: '2026-09-09T00:00:00.000Z',
        phases: [],
      },
      {
        kind: 'pr-review',
        owner: 'human',
        start: '2026-09-09T00:00:00.000Z',
        end: '2026-09-10T00:00:00.000Z',
        phases: [],
      },
    ]);
    expect(byId.get('fresh-idea')?.timeline).toEqual([
      { kind: 'idea', owner: 'human', start: '2026-09-01T00:00:00.000Z', end: null, phases: [] },
    ]);
  });

  it('ループの 1 手の記録を loop・loopSteps・AI の区間の phases に載せる', async () => {
    await writeCard(
      'looped',
      [
        '---',
        'id: looped',
        'title: ループ',
        "created: '2026-09-01T00:00:00.000Z'",
        "startedAt: '2026-09-02T00:00:00.000Z'",
        '---',
        '',
      ].join('\n')
    );
    const written = await store.transact('loop: テストの準備', (dataDir) => {
      const started = writeLoopStart(dataDir, {
        loop: 'session-a',
        cardId: 'looped',
        action: 'plan',
        step: null,
        agent: 'board-planner',
        harness: null,
        startedAt: '2026-09-02T06:00:00.000Z',
      });
      if (isErr(started)) return Promise.resolve(started);
      return Promise.resolve(
        writeLoopFinish(dataDir, {
          loop: 'session-a',
          cardId: 'looped',
          result: 'stopped',
          tokens: 5000,
          durationMs: 60_000,
          finishedAt: '2026-09-02T07:00:00.000Z',
        })
      );
    });
    if (isErr(written)) throw new Error('準備に失敗しました');

    const response = await request(buildApp()).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(response.body.loop).toEqual({ running: [], lastFinishedAt: '2026-09-02T07:00:00.000Z' });
    expect(card.loopSteps).toHaveLength(1);
    expect(card.loopSteps[0]).toMatchObject({ result: 'stopped', tokens: 5000 });
    expect(card.timeline[1]).toEqual({
      kind: 'planning',
      owner: 'ai',
      start: '2026-09-02T00:00:00.000Z',
      end: null,
      phases: [
        { kind: 'wait', start: '2026-09-02T00:00:00.000Z', end: '2026-09-02T06:00:00.000Z' },
        { kind: 'work', start: '2026-09-02T06:00:00.000Z', end: '2026-09-02T07:00:00.000Z' },
        { kind: 'wait', start: '2026-09-02T07:00:00.000Z', end: null },
      ],
    });
  });

  it('カードが無い計画ファイルを orphanPlans として返す', async () => {
    await writeFile('.ai-board/plans/orphan-plan.md', '# 計画');

    const response = await request(buildApp()).get('/api/board').expect(200);

    expect(response.body.orphanPlans).toEqual(['orphan-plan']);
  });

  it('レビューログから計画の承認を読み取って impling にする', async () => {
    await writeCard(
      'gated',
      [
        '---',
        'id: gated',
        'title: ゲート付き',
        'startedAt: 2026-09-05T00:00:00.000Z',
        '---',
        '',
        '## 探索メモ',
        '',
        '- 調べた',
        '',
        '## レビュー',
        '',
        '### 2026-09-06T00:00:00.000Z plan 承認',
        '',
      ].join('\n')
    );

    const response = await request(buildApp()).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.stage).toBe('impling');
    expect(card.gates).toEqual({ plan: 'approved' });
    expect(card.aborted).toBe(false);
    expect(card.droppableStages).toEqual([]);
  });

  it('AI が保留を書いて止まった計画提案中のカードに hold を載せる', async () => {
    await writeCard(
      'held',
      [
        '---',
        'id: held',
        'title: 保留',
        'startedAt: 2026-09-05T00:00:00.000Z',
        '---',
        '',
        '## レビュー',
        '',
        '### 2026-09-06T00:00:00.000Z plan 提出',
        '',
        '### 2026-09-07T00:00:00.000Z plan 否決',
        '',
        '### 2026-09-08T00:00:00.000Z plan 保留',
        '',
        '論点を決めてほしい。',
        '',
      ].join('\n')
    );
    await writeCard(
      'fresh',
      '---\nid: fresh\ntitle: 未提出\nstartedAt: 2026-09-05T00:00:00.000Z\n---\n'
    );

    const response = await request(buildApp()).get('/api/board').expect(200);
    const byId = new Map(
      (response.body.cards as { id: string; stage: string; hold: unknown }[]).map((card) => [
        card.id,
        card,
      ])
    );

    expect(byId.get('held')?.stage).toBe('planning');
    expect(byId.get('held')?.hold).toEqual({
      reason: expect.stringContaining('AI が計画を直しきれずに止まった') as unknown,
      since: '2026-09-08T00:00:00.000Z',
    });
    expect(byId.get('fresh')?.hold).toBeNull();
  });

  it('判断の後に Draft へ戻された PR のカードに hold を載せる', async () => {
    await writeCard(
      'reverted',
      [
        '---',
        'id: reverted',
        'title: Draft に戻された',
        'startedAt: 2026-09-05T00:00:00.000Z',
        'mr: 38',
        '---',
        '',
        '## レビュー',
        '',
        '### 2026-09-06T00:00:00.000Z plan 承認',
        '',
        '### 2026-09-07T00:00:00.000Z verify 承認',
        '',
      ].join('\n')
    );

    const mr: MrState = {
      forge: 'github',
      iid: 38 as MergeRequestIid,
      state: 'opened',
      draft: true,
      sourceBranch: 'reverted',
      title: 'Draft に戻された',
      webUrl: 'https://github.com/acme/board/pull/38',
      latestNoteAt: null,
      noteCount: 0,
      latestCommitAt: null,
      mergedAt: null,
      readyAt: null,
      convertedToDraftAt: '2026-09-08T00:00:00Z',
    };

    const response = await request(buildApp(stubMrProvider({ reverted: mr })))
      .get('/api/board')
      .expect(200);
    const card = response.body.cards[0];

    expect(card.stage).toBe('impling');
    expect(card.hold).toEqual({
      reason: expect.stringContaining('PR #38 が Draft に戻された') as unknown,
      since: '2026-09-08T00:00:00Z',
    });
  });

  it('待ちの列でなければゲートを問わず最新のエントリを latestReview として返す（中止は除く）', async () => {
    await writeCard(
      'waiting',
      [
        '---',
        'id: waiting',
        'title: 判断待ち',
        'startedAt: 2026-09-05T00:00:00.000Z',
        '---',
        '',
        '## レビュー',
        '',
        '### 2026-09-06T00:00:00.000Z plan 提出',
        '',
        '判断待ちの点は 1 つ。',
        '',
        '### 2026-09-07T00:00:00.000Z plan 中止',
        '',
      ].join('\n')
    );
    await writeCard('fresh', '---\nid: fresh\ntitle: 未提出\n---\n');

    const response = await request(buildApp()).get('/api/board').expect(200);
    const byId = new Map(
      (response.body.cards as { id: string; latestReview: unknown }[]).map((card) => [
        card.id,
        card.latestReview,
      ])
    );

    expect(byId.get('waiting')).toEqual({
      at: '2026-09-06T00:00:00.000Z',
      gate: 'plan',
      kind: '提出',
      reason: '判断待ちの点は 1 つ。',
    });
    expect(byId.get('fresh')).toBeNull();
  });

  it('計画レビューの列では、より新しい廃止した verify のエントリがあっても plan の最新を latestReview にする', async () => {
    await writeCard(
      'review',
      [
        '---',
        'id: review',
        'title: 計画レビュー中',
        'startedAt: 2026-09-05T00:00:00.000Z',
        '---',
        '',
        '## レビュー',
        '',
        '### 2026-09-06T00:00:00.000Z plan 提出',
        '',
        '計画を読んでほしい。',
        '',
        '### 2026-09-07T00:00:00.000Z verify 提出',
        '',
        '先走った動作確認の依頼。',
        '',
      ].join('\n')
    );
    await writeFile('.ai-board/plans/review.md', '# 計画\n');

    const response = await request(buildApp()).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.stage).toBe('plan-review');
    expect(card.latestReview).toEqual({
      at: '2026-09-06T00:00:00.000Z',
      gate: 'plan',
      kind: '提出',
      reason: '計画を読んでほしい。',
    });
  });

  it('廃止された explore のエントリはゲートにもステージにも現れない', async () => {
    await writeCard(
      'legacy',
      [
        '---',
        'id: legacy',
        'title: 旧ゲート',
        'startedAt: 2026-09-05T00:00:00.000Z',
        '---',
        '',
        '## 探索メモ',
        '',
        '- 調べた',
        '',
        '## レビュー',
        '',
        '### 2026-09-06T00:00:00.000Z explore 承認',
        '',
      ].join('\n')
    );

    const response = await request(buildApp()).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.stage).toBe('planning');
    expect(card.gates).toEqual({ plan: 'none' });
  });

  it('BoardCard に上書き関連のフィールドは現れない', async () => {
    await writeCard('plain', '---\nid: plain\ntitle: 素\n---\n');

    const response = await request(buildApp()).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card).not.toHaveProperty('stageOverride');
    expect(card).not.toHaveProperty('derivedStage');
    expect(card).not.toHaveProperty('diverged');
    expect(card).not.toHaveProperty('overridden');
  });
});

// ============================================================
// GET /api/plans/:id
// ============================================================

describe('GET /api/plans/:id', () => {
  it('計画の本文は配らない（人は計画を PR で読む）', async () => {
    await writeFile('.ai-board/plans/refresh-token.md', '# 計画');

    await request(buildApp()).get('/api/plans/refresh-token').expect(404);
  });
});

// ============================================================
// カード API
// ============================================================

describe('カード API', () => {
  it('POST /api/cards でカードを作り DB に残す', async () => {
    const app = buildApp();

    const response = await request(app)
      .post('/api/cards')
      .send({ title: 'Audit Log', body: '## アイデア\n監査ログを出したい' })
      .expect(201);

    expect(response.body.id).toBe('audit-log');

    const written = await readCard('audit-log');
    expect(written?.['title']).toBe('Audit Log');
    expect(written?.['body']).toContain('監査ログを出したい');
  });

  it('POST /api/cards は ID 重複を 409 で拒む', async () => {
    const app = buildApp();
    await request(app).post('/api/cards').send({ title: 'dup', id: 'dup' }).expect(201);

    const response = await request(app).post('/api/cards').send({ title: 'dup', id: 'dup' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('DUPLICATE_CARD_ID');
  });

  it('POST /api/cards は不正な入力を 400 で拒む', async () => {
    const response = await request(buildApp()).post('/api/cards').send({ title: '' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH /api/cards/:id で紐付けと着手マーカーを更新する', async () => {
    const app = buildApp();
    await request(app).post('/api/cards').send({ title: 'target', id: 'target' }).expect(201);

    const response = await request(app)
      .patch('/api/cards/target')
      .send({
        branch: 'feat/refresh-token',
        startedAt: '2026-09-04T10:00:00.000Z',
      })
      .expect(200);

    expect(response.body.branch).toBe('feat/refresh-token');
    expect(response.body.startedAt).toBe('2026-09-04T10:00:00.000Z');
  });

  it('PATCH で null を送ると着手を取り消せる', async () => {
    await writeCard(
      'hand-written',
      '---\nid: hand-written\ntitle: 手書き\nstartedAt: 2026-09-05T00:00:00.000Z\n---\n'
    );

    const response = await request(buildApp())
      .patch('/api/cards/hand-written')
      .send({ startedAt: null })
      .expect(200);

    expect(response.body.startedAt).toBeNull();
  });

  it('PATCH は存在しないカードを 404 にする', async () => {
    const response = await request(buildApp())
      .patch('/api/cards/missing')
      .send({ startedAt: '2026-09-05T00:00:00.000Z' });

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('CARD_NOT_FOUND');
  });

  it('PUT /api/cards/:id/body で本文を差し替える', async () => {
    const app = buildApp();
    await request(app).post('/api/cards').send({ title: 'target', id: 'target' }).expect(201);

    const response = await request(app)
      .put('/api/cards/target/body')
      .send({ body: '## 探索メモ\n調査結果' })
      .expect(200);

    expect(response.body.body).toBe('## 探索メモ\n調査結果');
  });

  it('GET /api/cards/:id で 1 件取得できる', async () => {
    const app = buildApp();
    await request(app).post('/api/cards').send({ title: 'target', id: 'target' }).expect(201);

    const response = await request(app).get('/api/cards/target').expect(200);

    expect(response.body.title).toBe('target');
  });

  it('不正な形式の ID は 404 にする', async () => {
    const response = await request(buildApp()).get('/api/cards/Bad%20Id');

    expect(response.status).toBe(404);
  });

  it('未定義の API パスは 404 を返す', async () => {
    const response = await request(buildApp()).get('/api/nope');

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('GET /api/health は ok を返す', async () => {
    await request(buildApp()).get('/api/health').expect(200, { status: 'ok' });
  });
});

// ============================================================
// データ用ブランチへの書き込み
// ============================================================

describe('画面の書き込みはデータ用ブランチへ push してから応答する', () => {
  /** origin が push を受け付けないようにする。fetch はできるので、取り直しても先頭が動かない拒否になる */
  async function rejectPushes(): Promise<void> {
    const hook = path.join(origin, 'hooks', 'pre-receive');
    await fs.mkdir(path.dirname(hook), { recursive: true });
    await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  }

  it('書き込み 1 回が 1 コミットとして origin に積まれる。コミットに理由は入れない', async () => {
    await writeCard(
      'target',
      "---\nid: target\ntitle: 対象\nstartedAt: '2026-09-05T00:00:00.000Z'\n---\n"
    );
    const app = buildApp();

    await request(app).post('/api/cards').send({ title: 'Audit Log' }).expect(201);
    await request(app).patch('/api/cards/target').send({ branch: 'feat/secret-name' }).expect(200);
    await request(app).put('/api/cards/target/body').send({ body: 'メモ' }).expect(200);
    await request(app)
      .post('/api/cards/target/reviews')
      .send({ gate: 'plan', kind: '否決', reason: '理由の文' })
      .expect(200);
    await request(app)
      .post('/api/cards/audit-log/move')
      .send({ after: null, before: 'target' })
      .expect(200);
    await request(app)
      .post('/api/idea-divider/move')
      .send({ after: 'audit-log', before: null })
      .expect(200);

    expect(originLog().slice(0, 6)).toEqual([
      'data: 区切り線を動かす',
      'data: audit-log を並べ替える',
      'data: target に plan 否決 を足す',
      'data: target の本文を差し替える',
      'data: target の branch を変える',
      'data: audit-log を作る',
    ]);
    expect(originLog().join('\n')).not.toContain('理由の文');
    expect(originLog().join('\n')).not.toContain('feat/secret-name');
  });

  it('何も変えない書き込みはコミットしない', async () => {
    await writeCard('same', '---\nid: same\ntitle: 同じ\n---\n本文');
    const before = originLog();

    await request(buildApp()).put('/api/cards/same/body').send({ body: '本文' }).expect(200);

    expect(originLog()).toEqual(before);
  });

  it('push が拒まれ続けたら 503 の DATA_STORE_PUSH_FAILED を返し、書きかけを残さない', async () => {
    await writeCard('target', '---\nid: target\ntitle: 対象\n---\n');
    await rejectPushes();
    const app = buildApp();

    const created = await request(app).post('/api/cards').send({ title: 'lost', id: 'lost' });
    expect(created.status).toBe(503);
    expect(created.body.code).toBe('DATA_STORE_PUSH_FAILED');

    const reviewed = await request(app)
      .post('/api/cards/target/reviews')
      .send({ gate: 'plan', kind: '承認', reason: '' });
    expect(reviewed.status).toBe(503);
    expect(reviewed.body.code).toBe('DATA_STORE_PUSH_FAILED');

    const board = await request(app).get('/api/board').expect(200);
    expect(board.body.cards.map((card: { id: string }) => card.id)).toEqual(['target']);
    expect(board.body.cards[0].stage).toBe('idea');
    expect(git(store.dataDir, 'status', '--porcelain')).toBe('');
  });

  it('origin に届かなければ 503 の DATA_STORE_FETCH_FAILED を返す', async () => {
    await writeCard('target', '---\nid: target\ntitle: 対象\n---\n');
    await fs.rename(origin, `${origin}.gone`);

    const response = await request(buildApp())
      .patch('/api/cards/target')
      .send({ branch: 'feat/x' });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('DATA_STORE_FETCH_FAILED');
    expect((await readCard('target'))?.branch).toBeNull();
  });

  it('push の前に、ほかの場所から push された最新を取り直してから書く', async () => {
    await writeCard('target', '---\nid: target\ntitle: 対象\n---\n');

    // ほかの clone（クラウドのセッションなど）が先にカードを足す
    const other = path.join(tmp, 'other', 'data');
    sh(['clone', '--quiet', '--branch', DATA_BRANCH, origin, other]);
    const otherStore = createDataStore({ dataDir: other, runner, lockPollMs: 10 });
    const pushed = await otherStore.transact('data: other を作る', () =>
      createFileCardDependencies(other).createCardCommand({
        title: 'other',
        id: 'other',
        createdAt: new Date('2026-09-01T00:00:00.000Z'),
      })
    );
    expect(isErr(pushed)).toBe(false);

    await request(buildApp()).patch('/api/cards/target').send({ branch: 'feat/x' }).expect(200);

    const board = await request(buildApp()).get('/api/board').expect(200);
    expect(board.body.cards.map((card: { id: string }) => card.id).sort()).toEqual([
      'other',
      'target',
    ]);
    expect(originLog()[0]).toBe('data: target の branch を変える');
  });

  it('判断のエントリを変える本文の差し替えは 409 の REVIEW_ENTRIES_CHANGED で拒み、push しない', async () => {
    await writeCard(
      'reviewed',
      [
        '---',
        'id: reviewed',
        'title: 判断済み',
        '---',
        '## レビュー',
        '',
        '### 2026-09-05T00:00:00.000Z plan 否決',
        '',
        '直してほしい',
      ].join('\n')
    );
    const before = originLog();

    const response = await request(buildApp())
      .put('/api/cards/reviewed/body')
      .send({ body: '## レビュー\n\n### 2026-09-05T00:00:00.000Z plan 承認' });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('REVIEW_ENTRIES_CHANGED');
    expect(originLog()).toEqual(before);
    expect((await readCard('reviewed'))?.body).toContain('plan 否決');
  });

  it('節の無い本文の差し替えは 200 で、判断は変わらずに残る', async () => {
    await writeCard(
      'reviewed',
      [
        '---',
        'id: reviewed',
        'title: 判断済み',
        '---',
        '## アイデア',
        '',
        '古い',
        '',
        '## レビュー',
        '',
        '### 2026-09-05T00:00:00.000Z plan 否決',
        '',
        '直してほしい',
      ].join('\n')
    );
    const before = await readCard('reviewed');

    const response = await request(buildApp())
      .put('/api/cards/reviewed/body')
      .send({ body: '## アイデア\n\n新しい' })
      .expect(200);

    expect(response.body.body).toBe('## アイデア\n\n新しい');
    expect(response.body.reviews).toEqual([
      {
        at: '2026-09-05T00:00:00.000Z',
        gate: 'plan',
        kind: '否決',
        reason: '直してほしい',
      },
    ]);

    const after = await readCard('reviewed');
    expect(after?.body).toMatch(/^## アイデア\n\n新しい\n\n## レビュー\n/);
    expect(parseReviewLog(after?.body ?? '')).toEqual(parseReviewLog(before?.body ?? ''));
    expect(originLog()[0]).toBe('data: reviewed の本文を差し替える');
  });
});

// ============================================================
// 書き込み範囲
// ============================================================

describe('書き込みは .ai-board/ 配下に限られる', () => {
  it('カード操作で .ai-board/plans/ が変化しない', async () => {
    await writeFile('.ai-board/plans/x.md', '# 計画');
    const before = await fs.readFile(path.join(root, '.ai-board/plans/x.md'), 'utf-8');

    const app = buildApp();
    await request(app).post('/api/cards').send({ title: 'x', id: 'x' }).expect(201);
    await request(app).patch('/api/cards/x').send({ branch: 'feat/x' }).expect(200);
    await request(app).put('/api/cards/x/body').send({ body: 'メモ' }).expect(200);

    const after = await fs.readFile(path.join(root, '.ai-board/plans/x.md'), 'utf-8');
    expect(after).toBe(before);
    expect(await fs.readdir(path.join(root, '.ai-board/plans'))).toEqual(['x.md']);
  });
});

// ============================================================
// ボード移動の制限
// ============================================================

describe('移動できる先の制限', () => {
  it('AI の成果物が無いカードは人の 2 列へ動かせる', async () => {
    await writeCard('free', '---\nid: free\ntitle: 自由\n---\n');

    const response = await request(buildApp()).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.floorStage).toBe('idea');
    expect(card.droppableStages).toEqual(['idea', 'planning']);
  });

  it('計画ファイルがあるカードはどこへも動かせない', async () => {
    await writeCard('proposed-card', '---\nid: proposed-card\ntitle: 提案済み\n---\n');
    await writeFile('.ai-board/plans/proposed-card.md', '# 計画');

    const response = await request(buildApp()).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.floorStage).toBe('plan-review');
    expect(card.droppableStages).toEqual([]);
  });

  it('Ready の PR があるカードはどこへも動かせない', async () => {
    await writeCard('in-review', '---\nid: in-review\ntitle: レビュー中\nmr: 42\n---\n');

    const mr: MrState = {
      forge: 'github',
      iid: 42 as MergeRequestIid,
      state: 'opened',
      draft: false,
      sourceBranch: 'feat/x',
      title: 'MR',
      webUrl: 'https://github.com/acme/board/pull/42',
      latestNoteAt: null,
      noteCount: 0,
      latestCommitAt: null,
      mergedAt: null,
      readyAt: null,
      convertedToDraftAt: null,
    };

    const response = await request(buildApp(stubMrProvider({ 'in-review': mr })))
      .get('/api/board')
      .expect(200);

    expect(response.body.cards[0].floorStage).toBe('pr');
    expect(response.body.cards[0].droppableStages).toEqual([]);
  });

  it('計画が archive 済みのカードはどこへも動かせない', async () => {
    await writeCard('finished', '---\nid: finished\ntitle: 完了\n---\n');
    await writeFile('.ai-board/plans/archive/finished.md', '# 済んだ計画');

    const response = await request(buildApp()).get('/api/board').expect(200);

    expect(response.body.cards[0].droppableStages).toEqual([]);
  });

  it('着手が打刻済みでも下限は変わらない', async () => {
    await writeCard(
      'started',
      '---\nid: started\ntitle: 着手済み\nstartedAt: 2026-09-04T10:00:00.000Z\n---\n'
    );

    const response = await request(buildApp()).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.stage).toBe('planning');
    expect(card.floorStage).toBe('idea');
    expect(card.droppableStages).toEqual(['idea', 'planning']);
  });
});

describe('stageOverride はもう存在しない', () => {
  it('PATCH で stageOverride を送っても無視される', async () => {
    const app = buildApp();
    await request(app).post('/api/cards').send({ title: 'target', id: 'target' }).expect(201);

    await request(app)
      .patch('/api/cards/target')
      .send({ stageOverride: 'merged', title: '別のタイトル' })
      .expect(200);

    const response = await request(app).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.title).toBe('別のタイトル');
    expect(card.stage).toBe('idea');
  });

  it('PATCH で stage をほかのフィールドと一緒に送ると stage だけが無視される', async () => {
    const app = buildApp();
    await request(app).post('/api/cards').send({ title: 'target', id: 'target' }).expect(201);

    await request(app)
      .patch('/api/cards/target')
      .send({ stage: 'merged', title: '別のタイトル' })
      .expect(200);

    const response = await request(app).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.title).toBe('別のタイトル');
    expect(card.stage).toBe('idea');
  });

  it('PATCH で stage だけを送ると更新するフィールドが無いので 400 になる', async () => {
    const app = buildApp();
    await request(app).post('/api/cards').send({ title: 'target', id: 'target' }).expect(201);

    await request(app).patch('/api/cards/target').send({ stage: 'merged' }).expect(400);

    const response = await request(app).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.title).toBe('target');
    expect(card.stage).toBe('idea');
  });

  it('手で書かれた上書きも読み取り側で無視される', async () => {
    await writeCard(
      'hand-override',
      '---\nid: hand-override\ntitle: 手書き上書き\nstageOverride: merged\n---\n'
    );

    const response = await request(buildApp()).get('/api/board').expect(200);

    expect(response.body.cards[0].stage).toBe('idea');
  });

  it('ドラッグ相当の PATCH で idea と planning を往復できる', async () => {
    await writeCard('drag-me', '---\nid: drag-me\ntitle: 移動\n---\n');
    const app = buildApp();

    await request(app)
      .patch('/api/cards/drag-me')
      .send({ startedAt: '2026-09-05T00:00:00.000Z' })
      .expect(200);

    const started = await request(app).get('/api/board').expect(200);
    expect(started.body.cards[0].stage).toBe('planning');

    await request(app).patch('/api/cards/drag-me').send({ startedAt: null }).expect(200);

    const reverted = await request(app).get('/api/board').expect(200);
    expect(reverted.body.cards[0].stage).toBe('idea');
  });
});

// ============================================================
// レビュー API
// ============================================================

describe('POST /api/cards/:id/reviews', () => {
  const AWAITING_CARD = [
    '---',
    'id: awaiting',
    'title: レビュー待ちのカード',
    'created: 2026-09-01T00:00:00.000Z',
    'startedAt: 2026-09-05T00:00:00.000Z',
    '---',
    '',
    '## アイデア',
    '',
    'なにかする。',
    '',
    '## 探索メモ',
    '',
    '- 調べた',
    '',
  ].join('\n');

  beforeEach(async () => {
    await writeCard('awaiting', AWAITING_CARD);
  });

  it('着手済みのカードは計画提案中から始まる', async () => {
    const response = await request(buildApp()).get('/api/board').expect(200);

    expect(response.body.cards[0].stage).toBe('planning');
  });

  it('承認を追記するとステージが進む', async () => {
    const app = buildApp();

    await request(app)
      .post('/api/cards/awaiting/reviews')
      .send({ gate: 'plan', kind: '承認' })
      .expect(200);

    const response = await request(app).get('/api/board').expect(200);

    expect(response.body.cards[0].stage).toBe('impling');
  });

  it('否決を追記すると計画提案中へ戻り、理由が本文に残る', async () => {
    const app = buildApp();

    await request(app)
      .post('/api/cards/awaiting/reviews')
      .send({ gate: 'plan', kind: '否決', reason: 'まだ浅い' })
      .expect(200);

    const response = await request(app).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.stage).toBe('planning');
    expect(card.reviews).toEqual([
      expect.objectContaining({ gate: 'plan', kind: '否決', reason: 'まだ浅い' }),
    ]);
  });

  it('理由の無い否決は 400', async () => {
    const response = await request(buildApp())
      .post('/api/cards/awaiting/reviews')
      .send({ gate: 'plan', kind: '否決' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(response.body.message).toContain('否決には理由を書いてください');
  });

  it('中止を追記すると aborted になる', async () => {
    const app = buildApp();

    await request(app)
      .post('/api/cards/awaiting/reviews')
      .send({ gate: 'plan', kind: '中止', reason: 'やめる' })
      .expect(200);

    const response = await request(app).get('/api/board').expect(200);

    expect(response.body.cards[0].aborted).toBe(true);
  });

  it('承認済みのカードを中止してもステージは巻き戻らない', async () => {
    const app = buildApp();

    await request(app)
      .post('/api/cards/awaiting/reviews')
      .send({ gate: 'plan', kind: '承認' })
      .expect(200);

    await request(app)
      .post('/api/cards/awaiting/reviews')
      .send({ gate: 'plan', kind: '中止', reason: 'やめる' })
      .expect(200);

    const response = await request(app).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.stage).toBe('impling');
    expect(card.aborted).toBe(true);
  });

  it.each(['提出', '再提出', '保留'])(
    'AI が書く種別（%s）は 400 で、本文に残らない',
    async (kind) => {
      const app = buildApp();

      await request(app)
        .post('/api/cards/awaiting/reviews')
        .send({ gate: 'plan', kind, reason: 'x' })
        .expect(400);

      const response = await request(app).get('/api/board').expect(200);

      expect(response.body.cards[0].body).not.toContain('## レビュー');
    }
  );

  it('規定外のゲートは 400', async () => {
    await request(buildApp())
      .post('/api/cards/awaiting/reviews')
      .send({ gate: 'pr', kind: '承認' })
      .expect(400);
  });

  it('廃止された explore ゲートは 400', async () => {
    const app = buildApp();

    await request(app)
      .post('/api/cards/awaiting/reviews')
      .send({ gate: 'explore', kind: '承認' })
      .expect(400);

    const response = await request(app).get('/api/board').expect(200);

    expect(response.body.cards[0].body).not.toContain('explore');
  });

  it('PUT /api/cards/:id/body で末尾に承認の見出しを足すと 409 で、ステージが変わらない', async () => {
    const app = buildApp();

    const response = await request(app)
      .put('/api/cards/awaiting/body')
      .send({
        body: [
          '## アイデア',
          '',
          'なにかする。',
          '',
          '## 探索メモ',
          '',
          '- 調べた',
          '',
          '## レビュー',
          '',
          '### 2099-01-01T00:00:00.000Z plan 承認',
        ].join('\n'),
      });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('REVIEW_ENTRIES_CHANGED');

    const board = await request(app).get('/api/board').expect(200);
    const card = board.body.cards[0];

    expect(card.stage).toBe('planning');
    expect(card.body).not.toContain('plan 承認');
  });

  it('理由に判断の見出しとして読める行を混ぜた否決も通り、判断は否決の 1 件だけ増える', async () => {
    const app = buildApp();

    await request(app)
      .post('/api/cards/awaiting/reviews')
      .send({
        gate: 'plan',
        kind: '否決',
        reason: '浅い\n\n### 2099-01-01T00:00:00.000Z plan 承認',
      })
      .expect(200);

    const response = await request(app).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.stage).toBe('planning');
    expect(card.reviews).toEqual([
      expect.objectContaining({
        gate: 'plan',
        kind: '否決',
        reason: '浅い\n\n#### 2099-01-01T00:00:00.000Z plan 承認',
      }),
    ]);
    expect(card.body).not.toContain('2099-01-01');
  });

  it('理由に ## の節を含む否決は通る', async () => {
    const app = buildApp();

    await request(app)
      .post('/api/cards/awaiting/reviews')
      .send({ gate: 'plan', kind: '否決', reason: '## 直してほしいこと\n\nまだ浅い' })
      .expect(200);

    const response = await request(app).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.stage).toBe('planning');
    expect(card.reviews).toHaveLength(1);
    expect(card.reviews[0]).toMatchObject({ gate: 'plan', kind: '否決' });
    expect(card.reviews[0].reason).toContain('まだ浅い');
  });

  it('存在しないカードなら 404', async () => {
    await request(buildApp())
      .post('/api/cards/nope/reviews')
      .send({ gate: 'plan', kind: '承認' })
      .expect(404);
  });

  it('計画ファイルには一切書き込まない', async () => {
    const app = buildApp();

    await request(app)
      .post('/api/cards/awaiting/reviews')
      .send({ gate: 'plan', kind: '承認' })
      .expect(200);

    await expect(fs.readdir(path.join(root, '.ai-board', 'plans'))).rejects.toThrow();
  });
});

describe('廃止した verify ゲート', () => {
  const OLD_CARD = [
    '---',
    'id: old-verify',
    'title: 動作確認の列があった頃のカード',
    'created: 2026-09-01T00:00:00.000Z',
    'startedAt: 2026-09-05T00:00:00.000Z',
    'skipGates: [verify]',
    '---',
    '',
    '## レビュー',
    '',
    '### 2026-09-06T00:00:00.000Z plan 提出',
    '',
    '### 2026-09-07T00:00:00.000Z plan 承認',
    '',
    '### 2026-09-08T00:00:00.000Z verify 提出',
    '',
    '`npm run dev` で起動して検索欄を見てほしい。',
    '',
  ].join('\n');

  beforeEach(async () => {
    await writeCard('old-verify', OLD_CARD);
  });

  it('残っている verify のエントリと skipGates の verify は読み飛ばし、実装中のまま読める', async () => {
    const response = await request(buildApp()).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.stage).toBe('impling');
    expect(card.gates).toEqual({ plan: 'approved' });
    expect(card.skipGates).toEqual([]);
    expect(card.latestReview).toMatchObject({ gate: 'plan', kind: '承認' });
    expect(card.reviews.map((entry: { gate: string }) => entry.gate)).toEqual(['plan', 'plan']);
  });

  it.each(['承認', '否決', '中止'])('verify の %s は 400 で、何も書かない', async (kind) => {
    const app = buildApp();

    await request(app)
      .post('/api/cards/old-verify/reviews')
      .send({ gate: 'verify', kind, reason: 'x' })
      .expect(400);

    const response = await request(app).get('/api/board').expect(200);
    expect(response.body.cards[0].reviews).toHaveLength(2);
  });

  it('skipGates に verify を書く PATCH は 400', async () => {
    await request(buildApp())
      .patch('/api/cards/old-verify')
      .send({ skipGates: ['verify'] })
      .expect(400);
  });
});

// ============================================================
// POST /api/cards/:id/move
// ============================================================

describe('POST /api/cards/:id/move', () => {
  async function writeCards(): Promise<void> {
    await writeCard('a', "---\nid: a\ntitle: A\ncreated: '2026-09-01T00:00:00.000Z'\n---\n");
    await writeCard('b', "---\nid: b\ntitle: B\ncreated: '2026-09-02T00:00:00.000Z'\n---\n");
    await writeCard('c', "---\nid: c\ntitle: C\ncreated: '2026-09-03T00:00:00.000Z'\n---\n");
  }

  async function boardOrder(app: Application): Promise<string[]> {
    const response = await request(app).get('/api/board').expect(200);
    return response.body.cards.map((card: { id: string }) => card.id);
  }

  it('rank が無ければ作成順に並ぶ', async () => {
    await writeCards();

    expect(await boardOrder(buildApp())).toEqual(['a', 'b', 'c']);
  });

  it('先頭・中間・末尾へ動かした結果がボードの順序に出る', async () => {
    await writeCards();
    const app = buildApp();

    await request(app).post('/api/cards/c/move').send({ after: null, before: 'a' }).expect(200);
    expect(await boardOrder(app)).toEqual(['c', 'a', 'b']);

    await request(app).post('/api/cards/b/move').send({ after: 'c', before: 'a' }).expect(200);
    expect(await boardOrder(app)).toEqual(['c', 'b', 'a']);

    const response = await request(app)
      .post('/api/cards/c/move')
      .send({ after: 'a', before: null })
      .expect(200);
    expect(await boardOrder(app)).toEqual(['b', 'a', 'c']);
    expect(typeof response.body.rank).toBe('number');
  });

  it('動かしたカードにだけ rank が書かれる', async () => {
    await writeCards();

    await request(buildApp())
      .post('/api/cards/c/move')
      .send({ after: 'a', before: 'b' })
      .expect(200);

    expect(typeof (await readCard('c'))?.['rank']).toBe('number');
    expect((await readCard('a'))?.['rank']).toBeNull();
  });

  it('存在しないカードは 404', async () => {
    await writeCards();

    await request(buildApp())
      .post('/api/cards/nope/move')
      .send({ after: 'a', before: null })
      .expect(404);
    await request(buildApp())
      .post('/api/cards/a/move')
      .send({ after: 'nope', before: null })
      .expect(404);
  });

  it('隣が逆順なら 409 を返す', async () => {
    await writeCards();

    const response = await request(buildApp())
      .post('/api/cards/a/move')
      .send({ after: 'c', before: 'b' })
      .expect(409);

    expect(response.body.code).toBe('STALE_ORDER');
  });

  it('入力が不正なら 400', async () => {
    await writeCards();
    const app = buildApp();

    await request(app).post('/api/cards/a/move').send({ after: 'b' }).expect(400);
    await request(app).post('/api/cards/a/move').send({ after: 'a', before: null }).expect(400);
  });
});

// ============================================================
// POST /api/idea-divider/move
// ============================================================

describe('POST /api/idea-divider/move', () => {
  async function writeCards(): Promise<void> {
    await writeCard('a', "---\nid: a\ntitle: A\ncreated: '2026-09-01T00:00:00.000Z'\n---\n");
    await writeCard('b', "---\nid: b\ntitle: B\ncreated: '2026-09-02T00:00:00.000Z'\n---\n");
    await writeCard('c', "---\nid: c\ntitle: C\ncreated: '2026-09-03T00:00:00.000Z'\n---\n");
  }

  it('一度も動かしていなければボードの ideaDivider は null', async () => {
    const response = await request(buildApp()).get('/api/board').expect(200);

    expect(response.body.ideaDivider).toBeNull();
  });

  it('区切り線を動かすと、その位置がボードの ideaDivider に出る', async () => {
    await writeCards();
    const app = buildApp();

    const moved = await request(app)
      .post('/api/idea-divider/move')
      .send({ after: 'a', before: 'b' })
      .expect(200);

    const board = await request(app).get('/api/board').expect(200);
    const rankOf = (id: string): number => {
      const card = board.body.cards.find((c: { id: string }) => c.id === id);
      return card.rank ?? Date.parse(card.created);
    };

    expect(board.body.ideaDivider).toBe(moved.body.rank);
    expect(rankOf('a')).toBeLessThan(board.body.ideaDivider);
    expect(rankOf('b')).toBeGreaterThan(board.body.ideaDivider);
  });

  it('カードの move で区切り線を隣に指定できる', async () => {
    await writeCards();
    const app = buildApp();
    await request(app).post('/api/idea-divider/move').send({ after: 'a', before: 'b' }).expect(200);

    const response = await request(app)
      .post('/api/cards/c/move')
      .send({ after: 'a', before: ':divider' })
      .expect(200);

    const board = await request(app).get('/api/board').expect(200);
    expect(response.body.rank).toBeLessThan(board.body.ideaDivider);
  });

  it('隣のカードが無ければ 404、逆順なら 409、不正な入力は 400', async () => {
    await writeCards();
    const app = buildApp();

    await request(app)
      .post('/api/idea-divider/move')
      .send({ after: 'nope', before: null })
      .expect(404);
    await request(app).post('/api/idea-divider/move').send({ after: 'c', before: 'a' }).expect(409);
    await request(app)
      .post('/api/idea-divider/move')
      .send({ after: ':divider', before: null })
      .expect(400);
  });
});
