import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFileCardDependencies } from '../../../cards/composition.js';
import { parseCard } from '../../../cards/repositories/card-markdown.js';
import { err, isErr } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { CommitMessage, DataOperation } from '../../../infrastructure/data-store.js';
import { createBoardDependencies } from '../../composition.js';
import type { PrStateProvider } from '../../services/pr-state-provider.js';
import type { GetBoardQuery } from '../queries/get-board.query.js';
import { createDecideCommands, type DecideDependencies } from '../commands/decide.command.js';

// ============================================================
// テスト用のデータ。git は使わず、ファイルのリポジトリで直に読み書きする
// ============================================================

let root: string;
let dataDir: string;
let commits: string[];

const NOW = new Date('2026-11-06T00:00:00.000Z');

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-decide-command-'));
  dataDir = path.join(root, 'data');
  commits = [];
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeIdea(id: string): Promise<void> {
  const card = parseCard(
    `${id}.md`,
    `---\nid: ${id}\ntitle: ${id} のタイトル\ncreated: '2026-11-01T00:00:00.000Z'\n---\n`
  );
  if (card === null || !(await createFileCardDependencies(dataDir).cardRepository.create(card))) {
    throw new Error(`テスト用のカードを作れません: ${id}`);
  }
}

const connected: PrStateProvider = {
  get: () => null,
  connection: () => ({ status: 'connected', kind: 'github' }),
  synced: () => true,
  failure: () => null,
};

function boardQuery(): GetBoardQuery {
  const cards = createFileCardDependencies(dataDir);
  return createBoardDependencies(
    path.join(root, '.ai-board', 'plans'),
    cards.cardRepository,
    cards.ideaDividerRepository,
    connected
  ).getBoardQuery;
}

/** `op` をそのまま 1 回走らせ、通ったらコミットしたことにしてメッセージを控える試しの store */
const onceStore: DecideDependencies['store'] = {
  transact: async <T, E>(message: CommitMessage<T>, op: DataOperation<T, E>) => {
    const result = await op(dataDir);
    if (result.ok) commits.push(typeof message === 'string' ? message : message(result.value));
    return result;
  },
};

function commands(loadBoard: GetBoardQuery, store = onceStore) {
  return createDecideCommands({ loadBoard, store, cards: createFileCardDependencies(dataDir) });
}

describe('createDecideCommands', () => {
  it('書いた判断と、書いた後に読み直した列を返し、コミットのメッセージを決める', async () => {
    await writeIdea('a');

    const result = await commands(boardQuery()).start({ id: 'a' as CardId, at: NOW });

    expect(result).toEqual({
      ok: true,
      value: { id: 'a', what: '着手', from: 'idea', to: 'planning' },
    });
    expect(commits).toEqual(['data: a の startedAt を変える']);
  });

  it('書いた後のボードが読めなければ、書いたまま to を null にして返す', async () => {
    await writeIdea('a');
    const load = boardQuery();
    let calls = 0;
    // 書き込みの中の 1 回目は読め、書いた後の読み直しだけが失敗する
    const flaky: GetBoardQuery = () => {
      calls += 1;
      return calls === 1 ? load() : Promise.resolve(err({ type: 'BoardUnreadable', reason: 'x' }));
    };

    const result = await commands(flaky).start({ id: 'a' as CardId, at: NOW });

    expect(result).toEqual({
      ok: true,
      value: { id: 'a', what: '着手', from: 'idea', to: null },
    });
    expect(commits).toEqual(['data: a の startedAt を変える']);
  });

  it('push が拒否されたら、取り直した状態でボードを導き直し、検査からやり直す', async () => {
    await writeIdea('a');
    const load = boardQuery();
    let loads = 0;
    const counting: GetBoardQuery = () => {
      loads += 1;
      return load();
    };

    // 1 回目の試みは push が拒否されたことにして書きかけを捨て、その間にほかのセッションが着手していた
    const backup = path.join(root, 'backup');
    const rejectedOnce: DecideDependencies['store'] = {
      transact: async <T, E>(message: CommitMessage<T>, op: DataOperation<T, E>) => {
        await fs.cp(dataDir, backup, { recursive: true });
        await op(dataDir);
        await fs.rm(dataDir, { recursive: true, force: true });
        await fs.cp(backup, dataDir, { recursive: true });

        const started = await createFileCardDependencies(dataDir).updateCardMetaCommand({
          id: 'a' as CardId,
          patch: { startedAt: '2026-11-05T00:00:00.000Z' },
        });
        if (isErr(started)) throw new Error('ほかのセッションの着手を書けません');

        const result = await op(dataDir);
        if (result.ok) commits.push(typeof message === 'string' ? message : message(result.value));
        return result;
      },
    };

    const result = await commands(counting, rejectedOnce).start({ id: 'a' as CardId, at: NOW });

    expect(result).toMatchObject({ ok: false, error: { type: 'StageMismatch', id: 'a' } });
    expect(loads).toBe(2);
    expect(commits).toEqual([]);
  });
});
