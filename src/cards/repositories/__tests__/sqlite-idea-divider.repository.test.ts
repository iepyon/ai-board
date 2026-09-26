import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../infrastructure/database.js';
import { SqliteIdeaDividerRepository } from '../sqlite-idea-divider.repository.js';

let db: DatabaseSync;

beforeEach(() => {
  db = openDatabase(':memory:');
});

afterEach(() => {
  db.close();
});

describe('SqliteIdeaDividerRepository', () => {
  it('一度も置いていなければ null', async () => {
    expect(await new SqliteIdeaDividerRepository(db).get()).toBe(null);
  });

  it('置いた値を読み、置き直すと 1 行のまま上書きする', async () => {
    const repository = new SqliteIdeaDividerRepository(db);

    await repository.set(1500);
    await repository.set(2500.5);

    expect(await repository.get()).toBe(2500.5);
    expect(db.prepare('SELECT count(*) AS n FROM idea_divider').get()).toEqual({ n: 1 });
  });

  it('書き込みの後に onWrite を呼ぶ', async () => {
    const onWrite = vi.fn();

    await new SqliteIdeaDividerRepository(db, onWrite).set(1);

    expect(onWrite).toHaveBeenCalledTimes(1);
  });
});
