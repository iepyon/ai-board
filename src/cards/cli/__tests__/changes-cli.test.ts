import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../infrastructure/database.js';
import {
  createCardDependencies,
  createChangeDependencies,
  type CardDependencies,
  type ChangeDependencies,
} from '../../composition.js';
import { applyChanges, describeApplyError, runChangesCli, type ChangesIo } from '../changes-cli.js';
import type { CardId } from '../../../shared/schemas/common.js';

let root: string;
let db: DatabaseSync;
let cards: CardDependencies;
let changes: ChangeDependencies;
let stdout: string;
let stderr: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-changes-cli-'));
  db = openDatabase(':memory:');
  cards = createCardDependencies(db);
  changes = createChangeDependencies(db, path.join(root, 'changes'), cards);
  stdout = '';
  stderr = '';
});

afterEach(async () => {
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});

const io: ChangesIo = {
  stdout: (text) => {
    stdout += text;
  },
  stderr: (text) => {
    stderr += text;
  },
  now: () => new Date('2026-09-27T07:15:00.000Z'),
};

async function createCard(id: string): Promise<void> {
  await cards.cardRepository.create({
    id: id as CardId,
    title: id,
    created: '2026-09-27T00:00:00.000Z',
    startedAt: null,
    skipGates: [],
    branch: null,
    mr: null,
    rank: null,
    body: '',
  });
}

describe('runChangesCli', () => {
  it('書き出したファイル名を出す', async () => {
    await createCard('a');

    expect(await runChangesCli(changes, io)).toBe(0);
    expect(stdout).toMatch(
      /変更を書き出しました: \.ai-board\/changes\/20260927T071500000Z-.{4}\.yaml（1 件の操作）/
    );
  });

  it('差分が無ければそう伝える', async () => {
    expect(await runChangesCli(changes, io)).toBe(0);
    expect(stdout).toBe('書き出す変更はありません\n');
  });

  it('読めない変更ファイルがあれば失敗する', async () => {
    await fs.mkdir(path.join(root, 'changes'));
    await fs.writeFile(path.join(root, 'changes', 'bad.yaml'), '- nope: 1\n');

    expect(await runChangesCli(changes, io)).toBe(1);
    expect(stderr).toContain('bad.yaml');
  });
});

describe('applyChanges', () => {
  it('適用したファイルの数を知らせる', async () => {
    await fs.mkdir(path.join(root, 'changes'));
    await fs.writeFile(
      path.join(root, 'changes', '1.yaml'),
      "- card: a\n  set:\n    title: A\n    created: '2026-09-27T00:00:00.000Z'\n"
    );

    expect(await applyChanges(changes, io)).toBe(true);
    expect(stderr).toContain('1 件適用しました');
  });
});

describe('describeApplyError', () => {
  it('書き出していない変更の対象と、次にすることを伝える', () => {
    expect(describeApplyError({ type: 'UnrecordedChanges', cardIds: ['a'], divider: true })).toBe(
      '[ai-board] DB に書き出していない変更があるため、変更ファイルを適用しませんでした（a, アイデアの区切り線）。先に ai-board changes を実行してください'
    );
  });
});

describe('applyChanges の例外', () => {
  it('適用が例外で失敗しても投げずに知らせる', async () => {
    const failing: ChangeDependencies = {
      ...changes,
      applyChangesCommand: () => Promise.reject(new Error('database is locked')),
    };

    expect(await applyChanges(failing, io)).toBe(false);
    expect(stderr).toContain('database is locked');
  });
});
