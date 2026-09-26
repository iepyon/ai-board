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
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../infrastructure/database.js';
import { parseCard } from '../../../cards/repositories/card-markdown.js';
import { SqliteCardRepository } from '../../../cards/repositories/sqlite-card.repository.js';

// ============================================================
// テスト用プロジェクトの組み立て
// ============================================================

let root: string;
let db: DatabaseSync;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-e2e-'));
  db = openDatabase(':memory:');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function writeFile(relativePath: string, content: string): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf-8');
}

/** カードを Markdown で書いて DB に入れる。移行前のカードファイルと同じ書式で用意できる */
async function writeCard(id: string, content: string): Promise<void> {
  const card = parseCard(`${id}.md`, content);
  if (card === null) throw new Error(`テスト用のカードが読めません: ${id}`);
  await new SqliteCardRepository(db).create(card);
}

async function readCard(id: string): Promise<Record<string, unknown> | undefined> {
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
}

function stubMrProvider(states: Record<string, MrState> = {}): MrStateProvider {
  return {
    get: (cardId) => states[cardId] ?? null,
    connection: () => ({ status: 'connected', kind: 'github' }),
  };
}

function buildApp(mrProvider?: MrStateProvider): Application {
  const cards = createCardDependencies(db);
  const board = createBoardDependencies(
    path.join(root, '.ai-board', 'plans'),
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

  it('ボードのレスポンスに計画の本文は含めない', async () => {
    // 計画 1 本はカード本文より桁違いに大きく、SSE のたびに引き直される。
    // 本文は詳細パネルを開いたときだけ取りに行く。
    await writeCard('heavy', '---\nid: heavy\ntitle: 重い\n---\n');
    await writeFile('.ai-board/plans/heavy.md', '# 計画\n\nここに長い本文が入る');

    const response = await request(buildApp()).get('/api/board').expect(200);

    expect(response.body.cards[0].plan).toEqual({
      tasks: { completed: 0, total: 0 },
      archived: false,
    });
    expect(JSON.stringify(response.body)).not.toContain('ここに長い本文が入る');
  });

  it('MR の状態を反映する', async () => {
    await writeCard('s3-upload', '---\nid: s3-upload\ntitle: S3 アップロード\nmr: 38\n---\n');

    const mr: MrState = {
      forge: 'gitlab',
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

    expect(response.body.cards[0].stage).toBe('pr');
    expect(response.body.cards[0].mrState.resubmitted).toBe(true);
    expect(response.body.cards[0].mrState.webUrl).toBe('http://localhost:8080/mr/38');
    expect(response.body.forge).toEqual({ status: 'connected', kind: 'github' });
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
  it('計画の本文と進捗を返す', async () => {
    await writeFile('.ai-board/plans/refresh-token.md', '# 計画\n\n- [x] 1\n- [ ] 2');

    const response = await request(buildApp()).get('/api/plans/refresh-token').expect(200);

    expect(response.body).toEqual({
      id: 'refresh-token',
      body: '# 計画\n\n- [x] 1\n- [ ] 2',
      tasks: { completed: 1, total: 2 },
    });
  });

  it('archive 配下の計画も読める', async () => {
    await writeFile('.ai-board/plans/archive/finished.md', '# 済んだ計画');

    const response = await request(buildApp()).get('/api/plans/finished').expect(200);

    expect(response.body.body).toBe('# 済んだ計画');
  });

  it('計画が無ければ 404', async () => {
    const response = await request(buildApp()).get('/api/plans/missing').expect(404);

    expect(response.body.code).toBe('PLAN_NOT_FOUND');
  });

  it('カード ID として不正な id は 404（パストラバーサルを通さない）', async () => {
    await writeFile('.ai-board/secret.md', 'これは計画ではない');

    const response = await request(buildApp())
      .get(`/api/plans/${encodeURIComponent('../secret')}`)
      .expect(404);

    expect(response.body.code).toBe('PLAN_NOT_FOUND');
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

  it('MR があるカードはどこへも動かせない', async () => {
    await writeCard('in-review', '---\nid: in-review\ntitle: レビュー中\nmr: 42\n---\n');

    const mr: MrState = {
      forge: 'gitlab',
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
    expect(card.body).toContain('まだ浅い');
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
