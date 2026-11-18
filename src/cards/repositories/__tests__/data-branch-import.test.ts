import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ok } from '../../../shared/result.js';
import { initialDocuments, MemoryDocumentStore } from '../../../infrastructure/document-store.js';
import type { CardId } from '../../../shared/schemas/common.js';
import { DocCardRepository } from '../doc-card.repository.js';
import { readDataBranchDocuments } from '../data-branch-import.js';

let dir: string;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-import-'));
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(file: string, content: string): void {
  const full = path.join(dir, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const CARD_MD = `---
id: a
title: カード A
created: '2026-10-01T00:00:00.000Z'
skipGates: []
branch: a
pr: 7
---

## アイデア

本文
`;

function writeBranch(): void {
  write('ai-board-data.yaml', 'version: 2\n');
  write('order.yaml', 'divider: 5\nranks:\n  a: 3\n');
  write('cards/a/card.md', CARD_MD);
  write('cards/a/log/20261002T000000.000Z.start.start.md', '');
  write('cards/a/log/20261003T000000.000Z.plan.submit.md', '判断してほしい点なし\n');
}

describe('readDataBranchDocuments', () => {
  it('カード・判断・並び順を文書にする', () => {
    writeBranch();

    const result = readDataBranchDocuments(dir);

    expect(result).toEqual(
      ok([
        { collection: 'order', id: 'order', data: { divider: 5, ranks: { a: 3 } } },
        {
          collection: 'cards',
          id: 'a',
          data: {
            id: 'a',
            title: 'カード A',
            created: '2026-10-01T00:00:00.000Z',
            skipGates: [],
            branch: 'a',
            pr: 7,
            body: '## アイデア\n\n本文',
          },
        },
        {
          collection: 'log',
          id: 'a.20261002T000000.000Z.start.start',
          data: {
            cardId: 'a',
            at: '2026-10-02T00:00:00.000Z',
            gate: 'start',
            kind: 'start',
            reason: '',
          },
        },
        {
          collection: 'log',
          id: 'a.20261003T000000.000Z.plan.submit',
          data: {
            cardId: 'a',
            at: '2026-10-03T00:00:00.000Z',
            gate: 'plan',
            kind: 'submit',
            reason: '判断してほしい点なし',
          },
        },
      ])
    );
  });

  it('移した文書から、移す前と同じカードを組み立てられる', async () => {
    writeBranch();
    const result = readDataBranchDocuments(dir);
    if (!result.ok) throw new Error(result.error);
    const store = new MemoryDocumentStore(initialDocuments());
    await store.transact('移す', () => {
      for (const doc of result.value) store.set(doc.collection, doc.id, doc.data);
      return Promise.resolve(ok(undefined));
    });

    const card = await new DocCardRepository(store).findById('a' as CardId);

    expect(card).toMatchObject({
      id: 'a',
      title: 'カード A',
      branch: 'a',
      pr: 7,
      rank: 3,
      startedAt: '2026-10-02T00:00:00.000Z',
    });
    expect(card?.body).toContain('### 2026-10-03T00:00:00.000Z plan 提出');
  });

  it('形の版が 2 でなければ読まない', () => {
    writeBranch();
    write('ai-board-data.yaml', 'version: 3\n');

    expect(readDataBranchDocuments(dir)).toEqual({
      ok: false,
      error: 'データ用ブランチの形の版が 3 です（移せるのは 2）',
    });
  });

  it('形の版のファイルが無い・ディレクトリが無いときは読まない', () => {
    expect(readDataBranchDocuments(dir).ok).toBe(false);
    expect(readDataBranchDocuments(path.join(dir, 'missing')).ok).toBe(false);
  });

  it('order.yaml が壊れていれば読まない', () => {
    writeBranch();
    write('order.yaml', 'ranks: [1\n');

    const result = readDataBranchDocuments(dir);
    expect(result.ok).toBe(false);
  });

  it('廃止したゲートの判断は警告せずに飛ばし、名前の読めない判断は警告して飛ばす', () => {
    writeBranch();
    write('cards/a/log/20261001T000000.000Z.explore.submit.md', '');
    write('cards/a/log/garbage.md', '');

    const result = readDataBranchDocuments(dir);
    if (!result.ok) throw new Error(result.error);

    expect(result.value.filter((doc) => doc.collection === 'log').map((doc) => doc.id)).toEqual([
      'a.20261002T000000.000Z.start.start',
      'a.20261003T000000.000Z.plan.submit',
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('garbage.md'));
  });

  it('読めないカードと ID として不正なディレクトリは警告して飛ばし、ほかは移す', () => {
    writeBranch();
    write('cards/broken/card.md', '---\nid: other\n---\n');
    write('cards/Bad_Id/card.md', CARD_MD);
    fs.mkdirSync(path.join(dir, 'cards', 'empty'), { recursive: true });

    const result = readDataBranchDocuments(dir);
    if (!result.ok) throw new Error(result.error);

    expect(result.value.filter((doc) => doc.collection === 'cards').map((doc) => doc.id)).toEqual([
      'a',
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Bad_Id'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('broken'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('empty'));
  });
});
