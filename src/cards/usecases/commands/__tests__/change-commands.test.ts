import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../../infrastructure/database.js';
import {
  createCardDependencies,
  createChangeDependencies,
  type CardDependencies,
  type ChangeDependencies,
} from '../../../composition.js';
import type { Card } from '../../../models/card.js';
import type { CardId } from '../../../../shared/schemas/common.js';

// ============================================================
// ワークツリー 1 つ分（DB と変更ファイルの置き場所）
// ============================================================

interface Worktree {
  readonly db: DatabaseSync;
  readonly dir: string;
  readonly cards: CardDependencies;
  readonly changes: ChangeDependencies;
}

let root: string;
const opened: DatabaseSync[] = [];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-change-commands-'));
});

afterEach(async () => {
  for (const db of opened.splice(0)) db.close();
  await fs.rm(root, { recursive: true, force: true });
});

function worktree(name: string): Worktree {
  const db = openDatabase(':memory:');
  opened.push(db);
  const dir = path.join(root, name, 'changes');
  const cards = createCardDependencies(db);

  return { db, dir, cards, changes: createChangeDependencies(db, dir, cards) };
}

/** git のマージの代わり。相手にしか無い変更ファイルを写す */
async function merge(from: Worktree, into: Worktree): Promise<void> {
  await fs.mkdir(into.dir, { recursive: true });
  for (const name of await listFiles(from)) {
    await fs.copyFile(path.join(from.dir, name), path.join(into.dir, name));
  }
}

async function listFiles(tree: Worktree): Promise<string[]> {
  try {
    return (await fs.readdir(tree.dir)).sort();
  } catch {
    return [];
  }
}

function makeCard(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id: id as CardId,
    title: `${id} のタイトル`,
    created: '2026-09-27T00:00:00.000Z',
    startedAt: null,
    skipGates: [],
    branch: null,
    mr: null,
    rank: null,
    body: '',
    ...overrides,
  };
}

async function edit(tree: Worktree, id: string, patch: Partial<Card>): Promise<void> {
  const card = await tree.cards.cardRepository.findById(id as CardId);
  if (card === null) throw new Error(`カードがありません: ${id}`);
  await tree.cards.cardRepository.save({ ...card, ...patch });
}

async function cardOf(tree: Worktree, id: string): Promise<Card | null> {
  return tree.cards.cardRepository.findById(id as CardId);
}

let clock = Date.parse('2026-09-27T07:00:00.000Z');
/** 書き出すたびに時刻を進める（ファイル名の順を決めるため） */
function tick(): Date {
  clock += 1000;
  return new Date(clock);
}

// ============================================================
// 書き出し
// ============================================================

describe('recordChangesCommand', () => {
  it('書き出していない変更を 1 つのファイルに書き、適用済みとして記録する', async () => {
    const main = worktree('main');
    await main.cards.cardRepository.create(makeCard('a', { body: '本文' }));
    await main.cards.ideaDividerRepository.set(10);

    const result = await main.changes.recordChangesCommand(tick());

    expect(result.ok && result.value.opCount).toBe(2);
    expect(await listFiles(main)).toHaveLength(1);
    expect(main.db.prepare('SELECT count(*) AS n FROM applied_changes').get()).toEqual({ n: 1 });
  });

  it('差分が無ければファイルを作らない', async () => {
    const main = worktree('main');
    await main.cards.cardRepository.create(makeCard('a'));
    await main.changes.recordChangesCommand(tick());

    const second = await main.changes.recordChangesCommand(tick());

    expect(second).toEqual({ ok: true, value: { name: null, opCount: 0, missing: [] } });
    expect(await listFiles(main)).toHaveLength(1);
  });

  it('2 回目は変わった列だけを書く', async () => {
    const main = worktree('main');
    await main.cards.cardRepository.create(makeCard('a', { body: '本文' }));
    await main.changes.recordChangesCommand(tick());
    await edit(main, 'a', { rank: 5 });

    const second = await main.changes.recordChangesCommand(tick());
    const name = second.ok ? second.value.name : null;

    expect(await fs.readFile(path.join(main.dir, name ?? ''), 'utf-8')).toBe(
      '- card: a\n  set:\n    rank: 5\n'
    );
  });

  it('適用済みの記録があって手元に無いファイルを知らせる', async () => {
    const main = worktree('main');
    await main.cards.cardRepository.create(makeCard('a'));
    const first = await main.changes.recordChangesCommand(tick());
    await fs.rm(path.join(main.dir, first.ok ? (first.value.name ?? '') : ''));

    const second = await main.changes.recordChangesCommand(tick());

    expect(second.ok && second.value.missing).toEqual([first.ok && first.value.name]);
  });
});

// ============================================================
// 適用
// ============================================================

describe('applyChangesCommand', () => {
  it('新しい DB には全部を適用し、カードと区切り線が揃う', async () => {
    const main = worktree('main');
    await main.cards.cardRepository.create(makeCard('a', { body: '本文', rank: 1 }));
    await main.cards.ideaDividerRepository.set(10);
    await main.changes.recordChangesCommand(tick());

    const fresh = worktree('fresh');
    await merge(main, fresh);
    const result = await fresh.changes.applyChangesCommand(tick());

    expect(result.ok && result.value.applied).toHaveLength(1);
    expect(await cardOf(fresh, 'a')).toEqual(makeCard('a', { body: '本文', rank: 1 }));
    expect(await fresh.cards.ideaDividerRepository.get()).toBe(10);
  });

  it('適用済みのファイルは流し直さない', async () => {
    const main = worktree('main');
    await main.cards.cardRepository.create(makeCard('a'));
    await main.changes.recordChangesCommand(tick());

    expect(await main.changes.applyChangesCommand(tick())).toEqual({
      ok: true,
      value: { applied: [], missing: [] },
    });
  });

  it('別々のワークツリーで別々の列を変えても、マージで両方が残る', async () => {
    const main = worktree('main');
    await main.cards.cardRepository.create(makeCard('a', { body: '元の本文' }));
    await main.changes.recordChangesCommand(tick());

    const left = worktree('left');
    const right = worktree('right');
    await merge(main, left);
    await merge(main, right);
    await left.changes.applyChangesCommand(tick());
    await right.changes.applyChangesCommand(tick());

    await edit(left, 'a', { rank: 7 });
    await left.changes.recordChangesCommand(tick());
    await edit(right, 'a', { body: '右で書いた本文' });
    await right.changes.recordChangesCommand(tick());

    await merge(left, main);
    await merge(right, main);
    await main.changes.applyChangesCommand(tick());

    expect(await cardOf(main, 'a')).toEqual(makeCard('a', { rank: 7, body: '右で書いた本文' }));
  });

  it('同じ列を両方で変えたら、名前の順で後のファイルが勝つ（適用した順には依らない）', async () => {
    const main = worktree('main');
    await main.cards.cardRepository.create(makeCard('a'));
    await main.changes.recordChangesCommand(tick());

    const early = worktree('early');
    const late = worktree('late');
    await merge(main, early);
    await merge(main, late);
    await early.changes.applyChangesCommand(tick());
    await late.changes.applyChangesCommand(tick());

    await edit(early, 'a', { title: '先に書いた' });
    await early.changes.recordChangesCommand(tick());
    await edit(late, 'a', { title: '後に書いた' });
    await late.changes.recordChangesCommand(tick());

    // 後に書いた方を先にマージしても、名前の順で後のものが勝つ
    await merge(late, main);
    await main.changes.applyChangesCommand(tick());
    await merge(early, main);
    await main.changes.applyChangesCommand(tick());

    expect((await cardOf(main, 'a'))?.title).toBe('後に書いた');
  });

  it('書き出していない変更があれば、適用せずに知らせる', async () => {
    const main = worktree('main');
    await main.cards.cardRepository.create(makeCard('a'));
    await main.changes.recordChangesCommand(tick());

    const other = worktree('other');
    await merge(main, other);
    await other.changes.applyChangesCommand(tick());
    await edit(other, 'a', { title: '他で書いた' });
    await other.changes.recordChangesCommand(tick());

    await edit(main, 'a', { rank: 3 });
    await main.cards.ideaDividerRepository.set(1);
    await merge(other, main);
    const result = await main.changes.applyChangesCommand(tick());

    expect(result).toEqual({
      ok: false,
      error: { type: 'UnrecordedChanges', cardIds: ['a'], divider: true },
    });
    expect(await cardOf(main, 'a')).toEqual(makeCard('a', { rank: 3 }));
  });

  it('読めないファイルがあれば、何も適用しない', async () => {
    const main = worktree('main');
    await fs.mkdir(main.dir, { recursive: true });
    await fs.writeFile(
      path.join(main.dir, '1.yaml'),
      "- card: a\n  set:\n    title: A\n    created: '2026-09-27T00:00:00.000Z'\n"
    );
    await fs.writeFile(path.join(main.dir, '2.yaml'), '- card: b\n  set:\n    rank: 1\n');

    const result = await main.changes.applyChangesCommand(tick());

    expect(result.ok).toBe(false);
    expect(await main.cards.cardRepository.findAll()).toEqual([]);
    expect(main.db.prepare('SELECT count(*) AS n FROM applied_changes').get()).toEqual({ n: 0 });
  });
});
