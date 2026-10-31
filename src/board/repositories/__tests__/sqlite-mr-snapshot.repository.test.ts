import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../infrastructure/database.js';
import { SqliteMrSnapshotRepository } from '../sqlite-mr-snapshot.repository.js';
import type { MrSnapshot } from '../../models/mr-state.js';
import type { CardId, MergeRequestIid } from '../../../shared/schemas/common.js';

let db: DatabaseSync;

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(() => {
  db.close();
});

const id = 'refresh-token' as CardId;

function makeSnapshot(overrides: Partial<MrSnapshot['mr']> = {}): MrSnapshot {
  return {
    fingerprint: '[1,"open"]',
    mr: {
      forge: 'github',
      iid: 42 as MergeRequestIid,
      state: 'opened',
      draft: true,
      sourceBranch: 'refresh-token',
      title: 'リフレッシュトークン対応',
      webUrl: 'https://github.com/acme/board/pull/42',
      latestNoteAt: '2026-09-04T10:00:00Z',
      noteCount: 3,
      latestCommitAt: null,
      mergedAt: null,
      readyAt: null,
      convertedToDraftAt: null,
      ...overrides,
    },
  };
}

describe('SqliteMrSnapshotRepository', () => {
  it('書いた控えをそのまま読み戻す', async () => {
    const repository = new SqliteMrSnapshotRepository(db);

    await repository.save(id, makeSnapshot());

    expect(await repository.findAll()).toEqual(new Map([[id, makeSnapshot()]]));
  });

  it('書き直すと 1 行のまま上書きする', async () => {
    const repository = new SqliteMrSnapshotRepository(db);

    await repository.save(id, makeSnapshot());
    await repository.save(id, { ...makeSnapshot({ state: 'merged' }), fingerprint: 'next' });

    const found = (await repository.findAll()).get(id);
    expect(found?.fingerprint).toBe('next');
    expect(found?.mr.state).toBe('merged');
    expect(db.prepare('SELECT count(*) AS n FROM mr_snapshots').get()).toEqual({ n: 1 });
  });

  it('消した控えは読まない', async () => {
    const repository = new SqliteMrSnapshotRepository(db);

    await repository.save(id, makeSnapshot());
    await repository.delete(id);

    expect((await repository.findAll()).size).toBe(0);
  });

  it('形の合わない控えは黙って外す', async () => {
    // MrState に項目を足すと古い控えは形が合わなくなる。外して引き直させる
    const insert = db.prepare(
      'INSERT INTO mr_snapshots (card_id, fingerprint, mr) VALUES (?, ?, ?)'
    );
    insert.run('broken-json', 'x', '{');
    insert.run('missing-field', 'x', JSON.stringify({ iid: 1 }));
    insert.run('refresh-token', '[1,"open"]', JSON.stringify(makeSnapshot().mr));

    const found = await new SqliteMrSnapshotRepository(db).findAll();

    expect([...found.keys()]).toEqual([id]);
  });

  it('readyAt を持たない古い控えは外す', async () => {
    // マージ済みの PR は二度と引き直さないので、ここで外さないと readyAt が入らないまま残る
    const { readyAt: _readyAt, ...old } = makeSnapshot({ state: 'merged' }).mr;
    db.prepare('INSERT INTO mr_snapshots (card_id, fingerprint, mr) VALUES (?, ?, ?)').run(
      'refresh-token',
      '[1,"closed"]',
      JSON.stringify(old)
    );

    expect((await new SqliteMrSnapshotRepository(db).findAll()).size).toBe(0);
  });

  it('readyAt に時刻の入った控えを読み戻す', async () => {
    const repository = new SqliteMrSnapshotRepository(db);
    const snapshot = makeSnapshot({ draft: false, readyAt: '2026-09-04T09:00:00Z' });

    await repository.save(id, snapshot);

    expect((await repository.findAll()).get(id)?.mr.readyAt).toBe('2026-09-04T09:00:00Z');
  });
});
