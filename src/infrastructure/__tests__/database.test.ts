import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isErr } from '../../shared/result.js';
import type { CardId, MergeRequestIid } from '../../shared/schemas/common.js';
import type { Card } from '../../cards/models/card.js';
import type { MrSnapshot } from '../../board/models/mr-state.js';
import { readLegacyBoard } from '../database.js';
import { createLegacyDatabase, insertRawCard } from './legacy-database-fixture.js';

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-db-'));
  dbPath = path.join(dir, 'board.db');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 'alpha' as CardId,
    title: 'アルファ',
    created: '2026-09-01T00:00:00.000Z',
    startedAt: '2026-09-02T00:00:00.000Z',
    skipGates: ['plan'],
    branch: 'alpha',
    mr: 12 as MergeRequestIid,
    rank: 1500,
    body: '## アイデア\n\n本文\n\n## レビュー\n\n### 2026-09-03T00:00:00.000Z plan 提出\n',
    ...overrides,
  };
}

function snapshot(state: 'opened' | 'merged'): MrSnapshot {
  return {
    fingerprint: `fp-${state}`,
    mr: {
      forge: 'github',
      iid: 12 as MergeRequestIid,
      state,
      draft: false,
      sourceBranch: 'alpha',
      title: 'PR',
      webUrl: 'https://example.com/pr/12',
      latestNoteAt: null,
      noteCount: 0,
      latestCommitAt: null,
      mergedAt: state === 'merged' ? '2026-09-05T00:00:00.000Z' : null,
      readyAt: null,
      convertedToDraftAt: null,
    },
  };
}

describe('readLegacyBoard', () => {
  it('カード・区切り線・PR の状態の控えを読む', () => {
    const stored = card();
    createLegacyDatabase(dbPath, {
      cards: [stored, card({ id: 'beta' as CardId, startedAt: null, rank: null, mr: null })],
      divider: 250,
      mrSnapshots: [['alpha', snapshot('merged')]],
    });

    const result = readLegacyBoard(dbPath);
    if (isErr(result)) throw new Error(JSON.stringify(result.error));

    expect(result.value.cards.map((c) => c.id)).toEqual(['alpha', 'beta']);
    expect(result.value.cards[0]).toEqual(stored);
    expect(result.value.divider).toBe(250);
    expect(result.value.mrSnapshots.get('alpha' as CardId)).toEqual(snapshot('merged'));
  });

  it('区切り線が無ければ null、形の合わない控えは外す', () => {
    const malformed = { fingerprint: 'fp', mr: { iid: 'x' } } as unknown as MrSnapshot;
    createLegacyDatabase(dbPath, { cards: [card()], mrSnapshots: [['alpha', malformed]] });

    const result = readLegacyBoard(dbPath);
    if (isErr(result)) throw new Error(JSON.stringify(result.error));

    expect(result.value.divider).toBeNull();
    expect(result.value.mrSnapshots.size).toBe(0);
  });

  it('DB が無ければ、作らずに LegacyDatabaseMissing を返す', () => {
    expect(readLegacyBoard(dbPath)).toEqual({
      ok: false,
      error: { type: 'LegacyDatabaseMissing', dbPath },
    });
    expect(fs.existsSync(dbPath)).toBe(false);
  });

  it('最後の版でない DB は読まない', () => {
    createLegacyDatabase(dbPath, { version: 4 });

    const result = readLegacyBoard(dbPath);

    expect(isErr(result) && result.error.type).toBe('LegacyDatabaseUnreadable');
    expect(isErr(result) && 'reason' in result.error && result.error.reason).toContain('v4');
  });

  it('読めない行があれば、読み飛ばさずに失敗する', () => {
    createLegacyDatabase(dbPath, { cards: [card()] });
    insertRawCard(dbPath, { id: 'Bad_ID', title: '不正', created: '2026-09-01T00:00:00.000Z' });

    const result = readLegacyBoard(dbPath);

    expect(isErr(result) && result.error.type).toBe('LegacyDatabaseUnreadable');
    expect(isErr(result) && 'reason' in result.error && result.error.reason).toContain('Bad_ID');
  });

  it('DB のファイルを書き換えない', () => {
    createLegacyDatabase(dbPath, { cards: [card()] });
    const before = fs.readFileSync(dbPath);

    readLegacyBoard(dbPath);

    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });
});
