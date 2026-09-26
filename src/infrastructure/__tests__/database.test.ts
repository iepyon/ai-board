import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase, watchDatabase, type DatabaseWatcher } from '../database.js';

let dir: string;
let watcher: DatabaseWatcher | null = null;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-db-'));
});

afterEach(async () => {
  watcher?.close();
  watcher = null;
  await fs.rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('openDatabase', () => {
  it('置き場所のディレクトリが無ければ作り、スキーマを用意する', () => {
    const db = openDatabase(path.join(dir, 'nested', 'board.db'));

    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM cards').get()).toEqual({ n: 0 });
    db.close();
  });

  it('開き直してもマイグレーションを繰り返さない', () => {
    const dbPath = path.join(dir, 'board.db');
    const first = openDatabase(dbPath);
    first.prepare(`INSERT INTO cards (id, title, created) VALUES ('a', 'A', 'x')`).run();
    first.close();

    const second = openDatabase(dbPath);
    expect(second.prepare('SELECT id FROM cards').all()).toEqual([{ id: 'a' }]);
    second.close();
  });

  it('この版より新しいスキーマの DB は開かない', () => {
    const dbPath = path.join(dir, 'board.db');
    const db = openDatabase(dbPath);
    db.exec('PRAGMA user_version = 99');
    db.close();

    expect(() => openDatabase(dbPath)).toThrow(/v99/);
  });
});

describe('watchDatabase', () => {
  it('別の接続のコミットだけを通知する', async () => {
    const dbPath = path.join(dir, 'board.db');
    const server = openDatabase(dbPath);
    const cli = openDatabase(dbPath);
    const onChange = vi.fn();
    watcher = watchDatabase(server, onChange, 20);

    server.prepare(`INSERT INTO cards (id, title, created) VALUES ('own', 'A', 'x')`).run();
    await sleep(80);
    expect(onChange).not.toHaveBeenCalled();

    cli.prepare(`INSERT INTO cards (id, title, created) VALUES ('other', 'B', 'x')`).run();
    await sleep(80);
    expect(onChange).toHaveBeenCalledTimes(1);

    cli.close();
    server.close();
  });
});
