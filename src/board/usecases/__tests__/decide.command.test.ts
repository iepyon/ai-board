import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'node:path';
import { createCardDependencies } from '../../../cards/composition.js';
import { parseCard } from '../../../cards/repositories/card-markdown.js';
import { err, isErr, ok, type Result } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import {
  initialDocuments,
  MemoryDocumentStore,
  type TransactLabel,
} from '../../../infrastructure/document-store.js';
import { createBoardDependencies } from '../../composition.js';
import type { PrStateProvider } from '../../services/pr-state-provider.js';
import type { GetBoardQuery } from '../queries/get-board.query.js';
import { createDecideCommands, type DecideDependencies } from '../commands/decide.command.js';

// ============================================================
// テスト用のデータ。メモリの置き場所で直に読み書きする
// ============================================================

let store: MemoryDocumentStore;
let labels: string[];

const NOW = new Date('2026-11-06T00:00:00.000Z');
const PLANS = path.join('/nonexistent-ai-board-root', '.ai-board', 'plans');

beforeEach(() => {
  store = new MemoryDocumentStore(initialDocuments());
  labels = [];
});

async function writeIdea(id: string): Promise<void> {
  const card = parseCard(
    `${id}.md`,
    `---\nid: ${id}\ntitle: ${id} のタイトル\ncreated: '2026-11-01T00:00:00.000Z'\n---\n`
  );
  const created = await store.transact('test', async () =>
    ok(card !== null && (await createCardDependencies(store).cardRepository.create(card)))
  );
  if (!created.ok || !created.value) throw new Error(`テスト用のカードを作れません: ${id}`);
}

const connected: PrStateProvider = {
  get: () => null,
  connection: () => ({ status: 'connected', kind: 'github' }),
  synced: () => true,
  failure: () => null,
};

function boardQuery(): GetBoardQuery {
  const cards = createCardDependencies(store);
  return createBoardDependencies(
    PLANS,
    cards.cardRepository,
    cards.ideaDividerRepository,
    connected
  ).getBoardQuery;
}

/** 本物の transact に通し、通ったら束の名前を控える store */
function recordingStore(): DecideDependencies['store'] {
  return {
    transact: async <T, E>(label: TransactLabel<T>, op: () => Promise<Result<T, E>>) => {
      const result = await store.transact(label, op);
      if (result.ok) labels.push(typeof label === 'string' ? label : label(result.value));
      return result;
    },
  };
}

function commands(loadBoard: GetBoardQuery) {
  return createDecideCommands({
    loadBoard,
    store: recordingStore(),
    cards: createCardDependencies(store),
  });
}

describe('createDecideCommands', () => {
  it('書いた判断と、書いた後に読み直した列を返し、束の名前を決める', async () => {
    await writeIdea('a');

    const result = await commands(boardQuery()).start({ id: 'a' as CardId, at: NOW });

    expect(result).toEqual({
      ok: true,
      value: { id: 'a', what: '着手', from: 'idea', to: 'planning' },
    });
    expect(labels).toEqual(['a の startedAt を変える']);
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
    expect(labels).toEqual(['a の startedAt を変える']);
  });

  it('ほかのセッションが先に着手していれば、transact の中で導き直したボードで拒み、何も書かない', async () => {
    await writeIdea('a');
    const load = boardQuery();
    let loads = 0;
    const counting: GetBoardQuery = () => {
      loads += 1;
      return load();
    };

    // 判断を書く前に、ほかのセッションが着手を書いた
    const started = await store.transact('other', () =>
      createCardDependencies(store).updateCardMetaCommand({
        id: 'a' as CardId,
        patch: { startedAt: '2026-11-05T00:00:00.000Z' },
      })
    );
    if (isErr(started)) throw new Error('ほかのセッションの着手を書けません');

    const result = await commands(counting).start({ id: 'a' as CardId, at: NOW });

    expect(result).toMatchObject({ ok: false, error: { type: 'StageMismatch', id: 'a' } });
    expect(loads).toBe(1);
    expect(labels).toEqual([]);
  });
});
