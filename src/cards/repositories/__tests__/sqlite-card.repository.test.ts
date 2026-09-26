import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../infrastructure/database.js';
import { SqliteCardRepository } from '../sqlite-card.repository.js';
import type { Card } from '../../models/card.js';
import type { CardId, MergeRequestIid } from '../../../shared/schemas/common.js';

let db: DatabaseSync;

beforeEach(() => {
  db = openDatabase(':memory:');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

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

describe('SqliteCardRepository', () => {
  it('カードが無ければ空配列を返す', async () => {
    expect(await new SqliteCardRepository(db).findAll()).toEqual([]);
  });

  it('作成したカードをすべてのフィールドごと読み戻せる', async () => {
    const repository = new SqliteCardRepository(db);
    const card = makeCard({
      startedAt: '2026-09-05T00:00:00.000Z',
      skipGates: ['plan'],
      branch: 'feat/refresh-token',
      mr: 42 as MergeRequestIid,
      rank: 1500,
      body: '## アイデア\n本文',
    });

    expect(await repository.create(card)).toBe(true);
    expect(await repository.findById(card.id)).toEqual(card);
  });

  it('同じ ID では二重に作成できない', async () => {
    const repository = new SqliteCardRepository(db);

    expect(await repository.create(makeCard())).toBe(true);
    expect(await repository.create(makeCard({ title: '別のタイトル' }))).toBe(false);
    expect((await repository.findById('refresh-token' as CardId))?.title).toBe(
      'リフレッシュトークン対応'
    );
  });

  it('存在しないカードは保存できない', async () => {
    expect(await new SqliteCardRepository(db).save(makeCard())).toBe(false);
  });

  it('保存で内容を更新できる', async () => {
    const repository = new SqliteCardRepository(db);
    await repository.create(makeCard());

    expect(await repository.save(makeCard({ startedAt: '2026-09-05T00:00:00.000Z' }))).toBe(true);
    expect((await repository.findById('refresh-token' as CardId))?.startedAt).toBe(
      '2026-09-05T00:00:00.000Z'
    );
  });

  it('書き込みが成立したときだけ onWrite を呼ぶ', async () => {
    const onWrite = vi.fn();
    const repository = new SqliteCardRepository(db, onWrite);

    await repository.save(makeCard());
    expect(onWrite).not.toHaveBeenCalled();

    await repository.create(makeCard());
    await repository.create(makeCard());
    await repository.save(makeCard({ title: '更新' }));
    expect(onWrite).toHaveBeenCalledTimes(2);
  });

  it('rank、無ければ作成日時の順で返す', async () => {
    const repository = new SqliteCardRepository(db);
    await repository.create(
      makeCard({ id: 'later' as CardId, created: '2026-09-05T00:00:00.000Z' })
    );
    await repository.create(
      makeCard({ id: 'earlier' as CardId, created: '2026-09-01T00:00:00.000Z' })
    );
    await repository.create(
      makeCard({ id: 'ranked' as CardId, created: '2026-09-09T00:00:00.000Z', rank: 1000 })
    );

    expect((await repository.findAll()).map((card) => card.id)).toEqual([
      'ranked',
      'earlier',
      'later',
    ]);
  });

  it('規定外の値を持つ行は読み飛ばして残りを返す', async () => {
    const repository = new SqliteCardRepository(db);
    await repository.create(makeCard({ id: 'good' as CardId }));
    db.prepare(
      `INSERT INTO cards (id, title, created, skip_gates, body) VALUES ('bad', 'x', 'x', '["explore"]', '')`
    ).run();

    expect((await repository.findAll()).map((card) => card.id)).toEqual(['good']);
    expect(await repository.findById('bad' as CardId)).toBeNull();
  });

  it('存在しない ID には null を返す', async () => {
    expect(await new SqliteCardRepository(db).findById('missing' as CardId)).toBeNull();
  });
});
