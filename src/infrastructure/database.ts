import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// ============================================================
// カードの保存先 — SQLite
// ============================================================

/**
 * スキーマの版。`PRAGMA user_version` に書く。
 *
 * 列を足すときは MIGRATIONS に 1 要素を追記し、既存の要素は書き換えない。
 * 書き換えると、古い版の DB を持つ人だけが違うスキーマで動く。
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE cards (
     id         TEXT PRIMARY KEY NOT NULL,
     title      TEXT NOT NULL,
     created    TEXT NOT NULL,
     started_at TEXT,
     skip_gates TEXT NOT NULL DEFAULT '[]',
     branch     TEXT,
     mr         INTEGER,
     forge      TEXT,
     rank       REAL,
     body       TEXT NOT NULL DEFAULT ''
   ) STRICT`,
];

/** 別プロセスの書き込みでロックが取れないとき、失敗にする前に待つ時間 */
const BUSY_TIMEOUT_MS = 5000;

/**
 * DB を開き、スキーマを最新の版まで進める。
 *
 * サーバと `ai-board card` の CLI が同じファイルを同時に開くため WAL にする。
 * 読み手が書き手を待たずに済む。
 */
export function openDatabase(dbPath: string): DatabaseSync {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec('PRAGMA journal_mode = WAL');
  migrate(db);

  return db;
}

function migrate(db: DatabaseSync): void {
  const current = readPragmaNumber(db, 'user_version');

  if (current > MIGRATIONS.length) {
    // 新しい版の ai-board が作った DB を古い版で開いた。黙って書くと列を失う
    throw new Error(
      `DB のスキーマ (v${current}) がこの ai-board (v${MIGRATIONS.length}) より新しいです。ai-board を更新してください`
    );
  }

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[version] ?? '');
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

// ============================================================
// 別プロセスの書き込みの検知
// ============================================================

const DEFAULT_POLL_MS = 500;

export interface DatabaseWatcher {
  close(): void;
}

/**
 * 別の接続（`ai-board card` の CLI など）がコミットしたら通知する。
 *
 * `PRAGMA data_version` は他の接続がコミットしたときだけ増え、
 * 自分の接続の書き込みでは変わらない。サーバ自身の書き込みは
 * リポジトリの `onWrite` で通知しているので、ここで二重に拾わない。
 *
 * WAL のファイルをファイル監視する方法は、チェックポイントでも発火し、
 * 書き込みの無い変更を拾ってしまうため採らない。
 */
export function watchDatabase(
  db: DatabaseSync,
  onChange: () => void,
  intervalMs: number = DEFAULT_POLL_MS
): DatabaseWatcher {
  let last = readPragmaNumber(db, 'data_version');

  const timer = setInterval(() => {
    const current = readPragmaNumber(db, 'data_version');
    if (current !== last) {
      last = current;
      onChange();
    }
  }, intervalMs);
  timer.unref?.();

  return { close: () => clearInterval(timer) };
}

function readPragmaNumber(db: DatabaseSync, name: 'user_version' | 'data_version'): number {
  const row = db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
  const value = row?.[name];

  return typeof value === 'number' ? value : 0;
}
