import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Application } from 'express';
import { createApp } from '../../../app.js';
import { createCardDependencies } from '../../../cards/composition.js';
import { createBoardDependencies } from '../../composition.js';
import type { MrStateProvider } from '../../services/mr-state-provider.js';
import type { MrState } from '../../models/mr-state.js';
import type { MergeRequestIid } from '../../../shared/schemas/common.js';

// ============================================================
// テスト用プロジェクトの組み立て
// ============================================================

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-e2e-'));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function writeFile(relativePath: string, content: string): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf-8');
}

function stubMrProvider(states: Record<string, MrState> = {}): MrStateProvider {
  return {
    get: (cardId) => states[cardId] ?? null,
    connection: () => ({ status: 'connected' }),
  };
}

function buildApp(mrProvider?: MrStateProvider): Application {
  const cards = createCardDependencies(path.join(root, '.ai-board', 'cards'));
  const board = createBoardDependencies(
    path.join(root, 'openspec'),
    cards.cardRepository,
    mrProvider
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
      'explored',
      'proposed',
      'impling',
      'ai-pr',
      'ai-pr-fixed',
      'done',
    ]);
    expect(response.body.gitlab).toEqual({ status: 'disabled' });
  });

  it('openspec の実態からステージを導出する', async () => {
    await writeFile(
      '.ai-board/cards/refresh-token.md',
      '---\nid: refresh-token\ntitle: リフレッシュトークン対応\nchange: refresh-token\n---\n'
    );
    await writeFile('openspec/changes/refresh-token/proposal.md', '# Why');
    await writeFile('openspec/changes/refresh-token/tasks.md', '- [x] 1.1 done\n- [ ] 1.2 todo');

    const response = await request(buildApp()).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.stage).toBe('proposed');
    expect(card.openspec.tasks).toEqual({ completed: 1, total: 2 });
    expect(card.openspec.artifacts.proposal).toBe(true);
  });

  it('archive にある change は done になる', async () => {
    await writeFile(
      '.ai-board/cards/login-redesign.md',
      '---\nid: login-redesign\ntitle: ログイン画面刷新\nchange: login-redesign\n---\n'
    );
    await writeFile('openspec/changes/archive/2026-09-01-login-redesign/proposal.md', '# Why');

    const response = await request(buildApp()).get('/api/board').expect(200);

    expect(response.body.cards[0].stage).toBe('done');
    expect(response.body.cards[0].openspec.archivedAs).toBe('2026-09-01-login-redesign');
  });

  it('MR の状態を反映する', async () => {
    await writeFile(
      '.ai-board/cards/s3-upload.md',
      '---\nid: s3-upload\ntitle: S3 アップロード\nmr: 38\n---\n'
    );

    const mr: MrState = {
      iid: 38 as MergeRequestIid,
      state: 'opened',
      sourceBranch: 'feat/s3',
      title: 'S3 アップロード',
      webUrl: 'http://localhost:8080/mr/38',
      latestNoteAt: '2026-09-04T10:00:00.000Z',
      noteCount: 1,
      latestCommitAt: '2026-09-04T10:30:00.000Z',
    };

    const response = await request(buildApp(stubMrProvider({ 's3-upload': mr })))
      .get('/api/board')
      .expect(200);

    expect(response.body.cards[0].stage).toBe('ai-pr-fixed');
    expect(response.body.cards[0].mrState.webUrl).toBe('http://localhost:8080/mr/38');
    expect(response.body.gitlab).toEqual({ status: 'connected' });
  });

  it('カードに紐付いていない change を orphanChanges として返す', async () => {
    await writeFile('openspec/changes/orphan-change/proposal.md', '# Why');

    const response = await request(buildApp()).get('/api/board').expect(200);

    expect(response.body.orphanChanges).toEqual(['orphan-change']);
  });

  it('手動上書きと自動導出の乖離を返す', async () => {
    await writeFile(
      '.ai-board/cards/overridden.md',
      '---\nid: overridden\ntitle: 上書き\nchange: overridden\nstageOverride: done\n---\n'
    );
    await writeFile('openspec/changes/overridden/proposal.md', '# Why');

    const response = await request(buildApp()).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.stage).toBe('done');
    expect(card.derivedStage).toBe('proposed');
    expect(card.diverged).toBe(true);
  });
});

// ============================================================
// カード API
// ============================================================

describe('カード API', () => {
  it('POST /api/cards でカードを作りファイルに残す', async () => {
    const app = buildApp();

    const response = await request(app)
      .post('/api/cards')
      .send({ title: 'Audit Log', body: '## アイデア\n監査ログを出したい' })
      .expect(201);

    expect(response.body.id).toBe('audit-log');

    const written = await fs.readFile(path.join(root, '.ai-board/cards/audit-log.md'), 'utf-8');
    expect(written).toContain('id: audit-log');
    expect(written).toContain('監査ログを出したい');
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

  it('PATCH /api/cards/:id で紐付けと実装開始マーカーを更新する', async () => {
    const app = buildApp();
    await request(app).post('/api/cards').send({ title: 'target', id: 'target' }).expect(201);

    const response = await request(app)
      .patch('/api/cards/target')
      .send({
        change: 'refresh-token',
        branch: 'feat/refresh-token',
        implStartedAt: '2026-09-04T10:00:00.000Z',
      })
      .expect(200);

    expect(response.body.change).toBe('refresh-token');
    expect(response.body.implStartedAt).toBe('2026-09-04T10:00:00.000Z');
  });

  it('PATCH で null を送ると手書きの上書きを解除できる', async () => {
    await writeFile(
      '.ai-board/cards/hand-written.md',
      '---\nid: hand-written\ntitle: 手書き\nstageOverride: done\n---\n'
    );

    const response = await request(buildApp())
      .patch('/api/cards/hand-written')
      .send({ stageOverride: null })
      .expect(200);

    expect(response.body.stageOverride).toBeNull();
  });

  it('PATCH は存在しないカードを 404 にする', async () => {
    const response = await request(buildApp()).patch('/api/cards/missing').send({ explored: true });

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
// 書き込み範囲
// ============================================================

describe('書き込みは .ai-board/ 配下に限られる', () => {
  it('カード操作で openspec/ が変化しない', async () => {
    await writeFile('openspec/changes/refresh-token/proposal.md', '# Why');
    const before = await fs.readFile(
      path.join(root, 'openspec/changes/refresh-token/proposal.md'),
      'utf-8'
    );

    const app = buildApp();
    await request(app).post('/api/cards').send({ title: 'x', id: 'x' }).expect(201);
    await request(app).patch('/api/cards/x').send({ change: 'refresh-token' }).expect(200);
    await request(app).put('/api/cards/x/body').send({ body: 'メモ' }).expect(200);

    const after = await fs.readFile(
      path.join(root, 'openspec/changes/refresh-token/proposal.md'),
      'utf-8'
    );
    expect(after).toBe(before);
    expect(await fs.readdir(path.join(root, 'openspec/changes'))).toEqual(['refresh-token']);
  });
});

// ============================================================
// ボード移動の制限
// ============================================================

describe('移動できる先の制限', () => {
  it('AI の成果物が無いカードは人の 3 列すべてへ動かせる', async () => {
    await writeFile('.ai-board/cards/free.md', '---\nid: free\ntitle: 自由\n---\n');

    const response = await request(buildApp()).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.floorStage).toBe('idea');
    expect(card.droppableStages).toEqual(['idea', 'explored', 'impling']);
  });

  it('proposal.md があるカードは実装中にしか落とせない', async () => {
    await writeFile(
      '.ai-board/cards/proposed-card.md',
      '---\nid: proposed-card\ntitle: 提案済み\nchange: proposed-card\n---\n'
    );
    await writeFile('openspec/changes/proposed-card/proposal.md', '# Why');

    const response = await request(buildApp()).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.floorStage).toBe('proposed');
    expect(card.droppableStages).toEqual(['impling']);
  });

  it('MR があるカードはどこへも動かせない', async () => {
    await writeFile(
      '.ai-board/cards/in-review.md',
      '---\nid: in-review\ntitle: レビュー中\nmr: 42\n---\n'
    );

    const mr: MrState = {
      iid: 42 as MergeRequestIid,
      state: 'opened',
      sourceBranch: 'feat/x',
      title: 'MR',
      webUrl: 'http://localhost:8080/mr/42',
      latestNoteAt: null,
      noteCount: 0,
      latestCommitAt: null,
    };

    const response = await request(buildApp(stubMrProvider({ 'in-review': mr })))
      .get('/api/board')
      .expect(200);

    expect(response.body.cards[0].floorStage).toBe('ai-pr');
    expect(response.body.cards[0].droppableStages).toEqual([]);
  });

  it('archive 済みのカードはどこへも動かせない', async () => {
    await writeFile(
      '.ai-board/cards/finished.md',
      '---\nid: finished\ntitle: 完了\nchange: finished\n---\n'
    );
    await writeFile('openspec/changes/archive/2026-09-01-finished/proposal.md', '# Why');

    const response = await request(buildApp()).get('/api/board').expect(200);

    expect(response.body.cards[0].droppableStages).toEqual([]);
  });

  it('実装開始が打刻済みでも下限は変わらない', async () => {
    await writeFile(
      '.ai-board/cards/started.md',
      '---\nid: started\ntitle: 実装中\nexplored: true\nimplStartedAt: 2026-09-04T10:00:00.000Z\n---\n'
    );

    const response = await request(buildApp()).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.stage).toBe('impling');
    expect(card.floorStage).toBe('idea');
    expect(card.droppableStages).toEqual(['idea', 'explored', 'impling']);
  });
});

describe('stageOverride は API から設定できない', () => {
  it('AI の列を指定すると 400 で拒む', async () => {
    const app = buildApp();
    await request(app).post('/api/cards').send({ title: 'target', id: 'target' }).expect(201);

    const response = await request(app).patch('/api/cards/target').send({ stageOverride: 'done' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(response.body.message).toContain('実態から導出');
  });

  it('人の列であっても指定は拒む（フラグで表すため）', async () => {
    const app = buildApp();
    await request(app).post('/api/cards').send({ title: 'target', id: 'target' }).expect(201);

    const response = await request(app)
      .patch('/api/cards/target')
      .send({ stageOverride: 'explored' });

    expect(response.status).toBe(400);
  });

  it('上書きを外すと自動導出の列に戻る', async () => {
    await writeFile(
      '.ai-board/cards/release-me.md',
      '---\nid: release-me\ntitle: 解除\nstageOverride: done\n---\n'
    );
    const app = buildApp();

    // ドラッグと同じ操作（フラグ書き込み＋上書き解除）
    await request(app)
      .patch('/api/cards/release-me')
      .send({ explored: true, implStartedAt: null, stageOverride: null })
      .expect(200);

    const response = await request(app).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.stage).toBe('explored');
    expect(card.overridden).toBe(false);
    expect(card.diverged).toBe(false);
  });

  it('手で書かれた上書きは読み取り側では尊重する', async () => {
    await writeFile(
      '.ai-board/cards/hand-override.md',
      '---\nid: hand-override\ntitle: 手書き上書き\nstageOverride: done\n---\n'
    );

    const response = await request(buildApp()).get('/api/board').expect(200);
    const card = response.body.cards[0];

    expect(card.stage).toBe('done');
    expect(card.derivedStage).toBe('idea');
    expect(card.diverged).toBe(true);
  });
});
