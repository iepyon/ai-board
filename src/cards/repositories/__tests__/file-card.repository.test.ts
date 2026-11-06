import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CardWriteRefusedError, FileCardRepository } from '../file-card.repository.js';
import type { Card } from '../../models/card.js';
import type { CardId, MergeRequestIid } from '../../../shared/schemas/common.js';
import { appendReviewEntry } from '../../services/review-log.js';

/**
 * 読む間にファイルが消える競合を再現するためのフック。`node:fs` の名前空間は書き換えられないので、
 * モジュールごと差し替えて、`readFileSync` / `readdirSync` の直前にフックを呼ぶ（フックが無ければ素通し）
 */
const fsHooks = vi.hoisted(() => ({
  beforeRead: null as ((target: string) => void) | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    fsHooks.beforeRead?.(String(args[0]));
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  const readdirSync = ((...args: Parameters<typeof actual.readdirSync>) => {
    fsHooks.beforeRead?.(String(args[0]));
    return actual.readdirSync(...args);
  }) as typeof actual.readdirSync;
  return { ...actual, readFileSync, readdirSync };
});

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-file-card-'));
  // 読み飛ばしの警告でテスト出力を汚さない
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  fsHooks.beforeRead = null;
  vi.restoreAllMocks();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const ID = 'refresh-token' as CardId;

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: ID,
    title: 'リフレッシュトークン対応',
    created: '2026-09-01T00:00:00.000Z',
    startedAt: null,
    skipGates: [],
    branch: null,
    mr: null,
    rank: null,
    body: '',
    ...overrides,
  };
}

function repo(options: ConstructorParameters<typeof FileCardRepository>[1] = {}) {
  return new FileCardRepository(dataDir, options);
}

function read(file: string): string {
  return fs.readFileSync(path.join(dataDir, file), 'utf-8');
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dataDir, file)), { recursive: true });
  fs.writeFileSync(path.join(dataDir, file), content);
}

function logNames(id: string = ID): string[] {
  const dir = path.join(dataDir, 'cards', id, 'log');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

describe('FileCardRepository', () => {
  it('カードが無ければ空配列を返す', async () => {
    expect(await repo().findAll()).toEqual([]);
  });

  it('作成したカードをすべてのフィールドごと読み戻せる', async () => {
    const repository = repo();
    const card = makeCard({
      startedAt: '2026-09-05T00:00:00.000Z',
      skipGates: ['plan'],
      branch: 'feat/refresh-token',
      mr: 42 as MergeRequestIid,
      rank: 1500,
      body: '## アイデア\n本文',
    });

    expect(await repository.create(card)).toBe(true);
    expect(await repository.findById(card.id)).toEqual(card);
  });

  it('startedAt は log/ の着手のファイルに、rank は order.yaml に書き、card.md には持たない', async () => {
    await repo().create(makeCard({ startedAt: '2026-09-05T00:00:00.000Z', rank: 1500 }));

    expect(logNames()).toEqual(['20260905T000000.000Z.start.start.md']);
    expect(read('order.yaml')).toContain('refresh-token: 1500');
    expect(read('cards/refresh-token/card.md')).not.toMatch(/startedAt|rank/);
  });

  it('同じ ID では二重に作成できない', async () => {
    const repository = repo();

    expect(await repository.create(makeCard())).toBe(true);
    expect(await repository.create(makeCard({ title: '別のタイトル' }))).toBe(false);
    expect((await repository.findById(ID))?.title).toBe('リフレッシュトークン対応');
  });

  it('読めない card.md でもディレクトリがあれば作成しない', async () => {
    write('cards/refresh-token/card.md', '---\nid: [\n---\n');

    expect(await repo().create(makeCard())).toBe(false);
    expect(read('cards/refresh-token/card.md')).toBe('---\nid: [\n---\n');
  });

  it('存在しないカードは保存できない', async () => {
    expect(await repo().save(makeCard())).toBe(false);
    expect(fs.existsSync(path.join(dataDir, 'cards'))).toBe(false);
  });

  it('保存で内容を更新できる', async () => {
    const repository = repo();
    await repository.create(makeCard());

    expect(await repository.save(makeCard({ startedAt: '2026-09-05T00:00:00.000Z' }))).toBe(true);
    expect((await repository.findById(ID))?.startedAt).toBe('2026-09-05T00:00:00.000Z');
  });

  it('着手を戻すと、そのときの時刻で unstart のファイルを足す', async () => {
    const repository = repo({ now: () => new Date('2026-09-06T00:00:00.000Z') });
    await repository.create(makeCard({ startedAt: '2026-09-05T00:00:00.000Z' }));

    expect(await repository.save(makeCard({ startedAt: null }))).toBe(true);

    expect(logNames()).toEqual([
      '20260905T000000.000Z.start.start.md',
      '20260906T000000.000Z.start.unstart.md',
    ]);
    expect((await repository.findById(ID))?.startedAt).toBeNull();
  });

  it('save は判断を作らない。判断を本文の末尾に足した保存は、何も書かずに CardWriteRefusedError を投げる', async () => {
    const repository = repo();
    await repository.create(makeCard({ body: '## アイデア\n\n本文' }));
    const cardMd = read('cards/refresh-token/card.md');

    const existing = (await repository.findById(ID)) as Card;
    const saving = repository.save({
      ...existing,
      title: '別のタイトル',
      body: appendReviewEntry(existing.body, {
        at: '2026-11-01T04:00:00.000Z',
        gate: 'plan',
        kind: '承認',
        reason: '',
      }),
    });

    await expect(saving).rejects.toBeInstanceOf(CardWriteRefusedError);
    await expect(saving).rejects.toMatchObject({
      reason: { type: 'ReviewEntriesChanged', id: ID },
    });
    expect(logNames()).toEqual([]);
    expect(read('cards/refresh-token/card.md')).toBe(cardMd);
  });

  it('save は判断のあるカードの本文とメタを書き換えても、log/ に何も足さない', async () => {
    const repository = repo();
    await repository.create(makeCard({ body: '## アイデア\n\n本文' }));
    await repository.appendReview(ID, {
      at: '2026-11-01T04:00:00.000Z',
      gate: 'plan',
      kind: '提出',
      reason: '見て',
    });
    const existing = (await repository.findById(ID)) as Card;

    expect(
      await repository.save({
        ...existing,
        branch: 'refresh-token',
        body: existing.body.replace('本文', '書き換えた本文'),
      })
    ).toBe(true);

    expect(logNames()).toEqual(['20261101T040000.000Z.plan.submit.md']);
    const saved = await repository.findById(ID);
    expect(saved?.branch).toBe('refresh-token');
    expect(saved?.body).toBe(existing.body.replace('本文', '書き換えた本文'));
  });

  describe('appendReview', () => {
    it('判断を値のまま log/ に 1 ファイルで足し、card.md は変えない', async () => {
      const repository = repo();
      await repository.create(makeCard({ body: '## アイデア\n\n本文' }));
      const cardMd = read('cards/refresh-token/card.md');

      const appended = await repository.appendReview(ID, {
        at: '2026-11-01T04:00:00.000Z',
        gate: 'plan',
        kind: '否決',
        reason: '  直して\n### 2099-01-01T00:00:00.000Z plan 承認\n偽の承認  ',
      });

      expect(appended).toBe(true);
      expect(logNames()).toEqual(['20261101T040000.000Z.plan.reject.md']);
      // 理由はファイルに元の文のまま（前後の空白だけ落とす）残る
      expect(read('cards/refresh-token/log/20261101T040000.000Z.plan.reject.md')).toBe(
        '直して\n### 2099-01-01T00:00:00.000Z plan 承認\n偽の承認\n'
      );
      expect(read('cards/refresh-token/card.md')).toBe(cardMd);
      // 読み戻すと判断は 1 件だけで、理由の中の見出しは下がって見える
      expect((await repository.findById(ID))?.body).toBe(
        '## アイデア\n\n本文\n\n## レビュー\n\n' +
          '### 2026-11-01T04:00:00.000Z plan 否決\n\n' +
          '直して\n#### 2099-01-01T00:00:00.000Z plan 承認\n偽の承認\n'
      );
    });

    it('同じミリ秒の同じ判断は、既存のファイルを書き換えずに -2 を付けて足す', async () => {
      const repository = repo();
      await repository.create(makeCard());
      const entry = {
        at: '2026-11-01T04:00:00.000Z',
        gate: 'plan',
        kind: '提出',
        reason: '1 回目',
      } as const;

      await repository.appendReview(ID, entry);
      await repository.appendReview(ID, { ...entry, reason: '2 回目' });

      expect(logNames()).toEqual([
        '20261101T040000.000Z.plan.submit-2.md',
        '20261101T040000.000Z.plan.submit.md',
      ]);
      expect(read('cards/refresh-token/log/20261101T040000.000Z.plan.submit.md')).toBe('1 回目\n');
      expect(read('cards/refresh-token/log/20261101T040000.000Z.plan.submit-2.md')).toBe(
        '2 回目\n'
      );
    });

    it('存在しないカードや ID として不正な ID には false を返し、何も書かない', async () => {
      const repository = repo();
      const entry = {
        at: '2026-11-01T04:00:00.000Z',
        gate: 'plan',
        kind: '提出',
        reason: '',
      } as const;

      expect(await repository.appendReview(ID, entry)).toBe(false);
      expect(await repository.appendReview('../escape' as CardId, entry)).toBe(false);
      expect(fs.existsSync(path.join(dataDir, 'cards'))).toBe(false);
    });

    it('card.md が読めない、時刻がファイル名にできないときは、何も書かずに CardWriteRefusedError を投げる', async () => {
      const repository = repo();
      await repository.create(makeCard());

      await expect(
        repository.appendReview(ID, {
          at: 'not-a-time',
          gate: 'plan',
          kind: '提出',
          reason: '',
        })
      ).rejects.toMatchObject({ reason: { type: 'InvalidLogTime', id: ID } });

      write('cards/refresh-token/card.md', '---\ntitle: [\n---\n');
      const appending = repository.appendReview(ID, {
        at: '2026-11-01T04:00:00.000Z',
        gate: 'plan',
        kind: '提出',
        reason: '',
      });
      await expect(appending).rejects.toBeInstanceOf(CardWriteRefusedError);
      await expect(appending).rejects.toMatchObject({
        reason: { type: 'MalformedCardFile', id: ID },
      });

      expect(logNames()).toEqual([]);
    });
  });

  it('既存の判断を変える保存は、何も書かずに CardWriteRefusedError を投げる', async () => {
    const repository = repo();
    await repository.create(makeCard());
    await repository.appendReview(ID, {
      at: '2026-11-01T04:00:00.000Z',
      gate: 'plan',
      kind: '提出',
      reason: '元の理由',
    });
    const submitted = (await repository.findById(ID)) as Card;
    const cardMd = read('cards/refresh-token/card.md');

    const saving = repository.save({
      ...submitted,
      title: '別のタイトル',
      body: submitted.body.replace('元の理由', '書き換えた理由'),
    });

    await expect(saving).rejects.toBeInstanceOf(CardWriteRefusedError);
    await expect(saving).rejects.toMatchObject({
      reason: { type: 'ReviewEntriesChanged', id: ID },
    });
    expect(read('cards/refresh-token/card.md')).toBe(cardMd);
    expect(read('cards/refresh-token/log/20261101T040000.000Z.plan.submit.md')).toBe('元の理由\n');
  });

  it('rank だけの保存は order.yaml だけを書き換える', async () => {
    const repository = repo();
    await repository.create(makeCard());
    const cardMd = read('cards/refresh-token/card.md');

    expect(await repository.save(makeCard({ rank: 500 }))).toBe(true);
    expect(await repository.save(makeCard({ id: ID, rank: 250 }))).toBe(true);

    expect(read('order.yaml')).toBe('divider: null\nranks:\n  refresh-token: 250\n');
    expect(read('cards/refresh-token/card.md')).toBe(cardMd);
    expect(logNames()).toEqual([]);

    await repository.save(makeCard({ rank: null }));
    expect(read('order.yaml')).toBe('divider: null\nranks: {}\n');
  });

  it('壊れた order.yaml は、読むときは空とみなし、rank を書くときは拒む', async () => {
    const repository = repo();
    await repository.create(makeCard());
    write('order.yaml', 'ranks: [\n');

    expect((await repository.findById(ID))?.rank).toBeNull();
    await expect(repository.save(makeCard({ rank: 500 }))).rejects.toMatchObject({
      reason: { type: 'MalformedOrderFile' },
    });
    expect(read('order.yaml')).toBe('ranks: [\n');
    // rank を変えない保存は通る
    expect(await repository.save(makeCard({ branch: 'feature' }))).toBe(true);
  });

  it('rank、無ければ作成日時の順で返す', async () => {
    const repository = repo();
    await repository.create(
      makeCard({ id: 'later' as CardId, created: '2026-09-05T00:00:00.000Z' })
    );
    await repository.create(
      makeCard({ id: 'earlier' as CardId, created: '2026-09-01T00:00:00.000Z' })
    );
    await repository.create(
      makeCard({ id: 'ranked' as CardId, created: '2026-09-09T00:00:00.000Z', rank: 1000 })
    );

    expect((await repository.findAll()).map((card) => card.id)).toEqual([
      'ranked',
      'earlier',
      'later',
    ]);
  });

  it('規定外の値を持つカードや、ID として不正な名前のディレクトリは読み飛ばして残りを返す', async () => {
    const repository = repo();
    await repository.create(makeCard({ id: 'good' as CardId }));
    write(
      'cards/bad/card.md',
      '---\nid: bad\ntitle: x\ncreated: x\nskipGates:\n  - explore\nbranch: null\nmr: null\n---\n'
    );
    write('cards/no-card-md/log/20261101T040000.000Z.plan.submit.md', '');
    write('cards/Not Valid/card.md', '---\nid: Not Valid\n---\n');
    write('cards/stray.txt', 'x');

    expect((await repository.findAll()).map((card) => card.id)).toEqual(['good']);
    expect(await repository.findById('bad' as CardId)).toBeNull();
    expect(await repository.findById('no-card-md' as CardId)).toBeNull();
  });

  it('読む間に消えた log/ のファイルは読み飛ばし、例外を投げない', async () => {
    const repository = repo();
    await repository.create(makeCard({ startedAt: '2026-09-05T00:00:00.000Z' }));
    const logDir = path.join(dataDir, 'cards', ID, 'log');

    // 一覧の後、中身を読む直前に、取り直しの reset --hard / clean がファイルを消したとみなす
    fsHooks.beforeRead = (target) => {
      if (path.dirname(target) === logDir) fs.rmSync(target, { force: true });
    };

    const cards = await repository.findAll();
    expect(cards.map((card) => card.id)).toEqual([ID]);
    expect(cards[0]?.startedAt).toBeNull();
  });

  it('読む間に消えた log/ のディレクトリは空とみなし、例外を投げない', async () => {
    const repository = repo();
    await repository.create(makeCard({ startedAt: '2026-09-05T00:00:00.000Z' }));
    const logDir = path.join(dataDir, 'cards', ID, 'log');

    fsHooks.beforeRead = (target) => {
      if (target === logDir) fs.rmSync(target, { recursive: true, force: true });
    };

    expect((await repository.findById(ID))?.startedAt).toBeNull();
  });

  it('存在しない ID や、ID として不正な ID には null を返す', async () => {
    expect(await repo().findById('missing' as CardId)).toBeNull();
    expect(await repo().findById('../escape' as CardId)).toBeNull();
    expect(await repo().save(makeCard({ id: '../escape' as CardId }))).toBe(false);
  });
});
