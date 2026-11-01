import { DatabaseSync } from 'node:sqlite';
import type { Card } from '../../cards/models/card.js';
import type { MrSnapshot } from '../../board/models/mr-state.js';

// ============================================================
// テスト用の移行前の DB（スキーマ v5）を作る
// ============================================================

/** 移行前の ai-board が作った最後の版のスキーマ */
const SCHEMA_V5 = `
  CREATE TABLE cards (
    id         TEXT PRIMARY KEY NOT NULL,
    title      TEXT NOT NULL,
    created    TEXT NOT NULL,
    started_at TEXT,
    skip_gates TEXT NOT NULL DEFAULT '[]',
    branch     TEXT,
    mr         INTEGER,
    rank       REAL,
    body       TEXT NOT NULL DEFAULT ''
  ) STRICT;
  CREATE TABLE idea_divider (
    id   INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
    rank REAL NOT NULL
  ) STRICT;
  CREATE TABLE mr_snapshots (
    card_id     TEXT PRIMARY KEY NOT NULL,
    fingerprint TEXT NOT NULL,
    mr          TEXT NOT NULL
  ) STRICT;
  PRAGMA user_version = 5;
`;

export interface LegacyFixture {
  readonly cards?: readonly Card[];
  readonly divider?: number | null;
  readonly mrSnapshots?: readonly (readonly [string, MrSnapshot])[];
  /** 既定は 5 */
  readonly version?: number;
}

/** `dbPath` に移行前の DB を作る。WAL にして、移行前のサーバと同じ形にする */
export function createLegacyDatabase(dbPath: string, fixture: LegacyFixture = {}): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_V5);
    if (fixture.version !== undefined) db.exec(`PRAGMA user_version = ${fixture.version}`);

    const insert = db.prepare(
      `INSERT INTO cards (id, title, created, started_at, skip_gates, branch, mr, rank, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const card of fixture.cards ?? []) {
      insert.run(
        card.id,
        card.title,
        card.created,
        card.startedAt,
        JSON.stringify(card.skipGates),
        card.branch,
        card.mr,
        card.rank,
        card.body
      );
    }

    if (fixture.divider !== undefined && fixture.divider !== null) {
      db.prepare('INSERT INTO idea_divider (id, rank) VALUES (1, ?)').run(fixture.divider);
    }

    const snapshot = db.prepare(
      'INSERT INTO mr_snapshots (card_id, fingerprint, mr) VALUES (?, ?, ?)'
    );
    for (const [cardId, value] of fixture.mrSnapshots ?? []) {
      snapshot.run(cardId, value.fingerprint, JSON.stringify(value.mr));
    }
  } finally {
    db.close();
  }
}

/** 行をそのまま足す（規定外の値を入れて、読めない行を作るため） */
export function insertRawCard(dbPath: string, row: Record<string, string | number | null>): void {
  const db = new DatabaseSync(dbPath);
  try {
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO cards (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
    ).run(...Object.values(row));
  } finally {
    db.close();
  }
}
