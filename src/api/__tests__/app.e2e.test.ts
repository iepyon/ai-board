import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFileCardDependencies } from '../../cards/composition.js';
import { parseCard } from '../../cards/repositories/card-markdown.js';
import { REVIEW_HEADING, parseReviewLog } from '../../cards/services/review-log.js';
import { isErr } from '../../shared/result.js';
import { createBoardDependencies } from '../../board/composition.js';
import type { MrStateProvider } from '../../board/services/mr-state-provider.js';
import { createApp, type ApiDependencies } from '../app.js';

// ============================================================
// API のサンプル（GET /api/board・POST /api/cards/:id/reviews）の e2e。git は使わない
// ============================================================

let root: string;
let dataDir: string;

const NOW = new Date('2026-11-05T00:00:00.000Z');

const connected: MrStateProvider = {
  get: () => null,
  connection: () => ({ status: 'connected', kind: 'github' }),
  synced: () => true,
  failure: () => null,
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-api-'));
  dataDir = path.join(root, 'data');
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeCard(id: string, frontmatter: string, body = ''): Promise<void> {
  const card = parseCard(
    `${id}.md`,
    `---\nid: ${id}\ntitle: ${id} のタイトル\n${frontmatter}---\n${body}`
  );
  if (card === null) throw new Error(`テスト用のカードが読めません: ${id}`);

  const cards = createFileCardDependencies(dataDir);
  const index = card.body.indexOf(REVIEW_HEADING);
  const prose = index === -1 ? card.body : card.body.slice(0, index).replace(/\n+$/, '');
  if (!(await cards.cardRepository.create({ ...card, body: prose }))) {
    throw new Error(`テスト用のカードを作れません: ${id}`);
  }
  for (const entry of parseReviewLog(card.body)) {
    const appended = await cards.appendReviewCommand({
      ...entry,
      id: card.id,
      at: new Date(entry.at),
    });
    if (isErr(appended)) throw new Error(`判断を足せません: ${JSON.stringify(appended.error)}`);
  }
}

async function writePlan(id: string): Promise<void> {
  const target = path.join(root, '.ai-board', 'plans', `${id}.md`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '# 計画\n\n- [ ] タスク\n', 'utf-8');
}

const STARTED = "created: '2026-11-01T00:00:00.000Z'\nstartedAt: '2026-11-02T00:00:00.000Z'\n";
const SUBMITTED = '## レビュー\n\n### 2026-11-03T00:00:00.000Z plan 提出\n\n理由\n';

function app(overrides: Partial<ApiDependencies> = {}) {
  const cards = createFileCardDependencies(dataDir);
  const { getBoardQuery } = createBoardDependencies(
    path.join(root, '.ai-board', 'plans'),
    cards.cardRepository,
    cards.ideaDividerRepository,
    connected
  );

  return createApp({
    loadBoard: async () => {
      const board = await getBoardQuery();
      return board.ok
        ? { ok: true, value: { board: board.value, snapshotTakenAt: '2026-11-04T12:00:00.000Z' } }
        : { ok: false, error: board.error.reason };
    },
    appendReview: cards.appendReviewCommand,
    now: () => NOW,
    ...overrides,
  });
}

async function reviewsOf(id: string) {
  const card = await createFileCardDependencies(dataDir).cardRepository.findById(id as never);
  return parseReviewLog(card?.body ?? '');
}

describe('GET /api/board', () => {
  it('status --json と同じ形のボードに、控えを取った時刻を付けて返す', async () => {
    await writeCard('reviewing', STARTED, SUBMITTED);
    await writePlan('reviewing');

    const res = await request(app()).get('/api/board');

    expect(res.status).toBe(200);
    expect(res.body.snapshotTakenAt).toBe('2026-11-04T12:00:00.000Z');
    expect(res.body.waiting).toEqual([
      expect.objectContaining({ id: 'reviewing', stage: 'plan-review' }),
    ]);
    expect(res.body.cards[0]).not.toHaveProperty('body');
  });

  it('ボードを組み立てられなければ 503', async () => {
    const res = await request(
      app({ loadBoard: async () => ({ ok: false, error: 'オフライン' }) })
    ).get('/api/board');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'BoardUnavailable', message: 'オフライン' });
  });

  it('残した 2 つのほかの口は無い', async () => {
    expect((await request(app()).get('/api/events')).status).toBe(404);
    expect((await request(app()).post('/api/cards').send({ title: 't' })).status).toBe(404);
  });
});

describe('POST /api/cards/:id/reviews', () => {
  it('計画レビューのカードに承認を書き、201 を返す', async () => {
    await writeCard('reviewing', STARTED, SUBMITTED);
    await writePlan('reviewing');

    const res = await request(app())
      .post('/api/cards/reviewing/reviews')
      .send({ gate: 'plan', kind: '承認', reason: 'よい' });

    expect(res.status).toBe(201);
    expect((await reviewsOf('reviewing')).at(-1)).toMatchObject({ kind: '承認', reason: 'よい' });
  });

  it('出せない判断は 409 で、出せる判断を添えて拒み、何も書かない', async () => {
    await writeCard('idea', "created: '2026-11-01T00:00:00.000Z'\n");

    const res = await request(app())
      .post('/api/cards/idea/reviews')
      .send({ gate: 'plan', kind: '承認' });

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'DecisionNotAvailable',
      stage: 'idea',
      available: ['plan 中止'],
    });
    expect(await reviewsOf('idea')).toEqual([]);
  });

  it('AI の種別・理由の無い否決・不正な ID は 400', async () => {
    await writeCard('reviewing', STARTED, SUBMITTED);
    await writePlan('reviewing');

    const post = (id: string, body: object) =>
      request(app()).post(`/api/cards/${id}/reviews`).send(body);

    expect((await post('reviewing', { gate: 'plan', kind: '提出' })).status).toBe(400);
    expect((await post('reviewing', { gate: 'plan', kind: '否決' })).status).toBe(400);
    expect((await post('reviewing', { gate: 'verify', kind: '承認' })).status).toBe(400);
    expect((await post('Not_An_Id', { gate: 'plan', kind: '承認' })).status).toBe(400);
    expect(await reviewsOf('reviewing')).toHaveLength(1);
  });

  it('カードが無ければ 404', async () => {
    const res = await request(app())
      .post('/api/cards/missing/reviews')
      .send({ gate: 'plan', kind: '中止' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'CardNotFound', id: 'missing' });
  });
});
