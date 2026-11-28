import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { err, isErr, ok } from '../../shared/result.js';
import type { BackedDocumentStore } from '../backed-document-store.js';
import { initialDocuments, STORE_VERSION } from '../document-store.js';
import {
  commentFromLog,
  createIssueDocumentStore,
  encodeMarker,
  issueFromCard,
  splitMarker,
} from '../issue-store-backend.js';
import { createFakeGithub, type FakeGithub } from './fake-github-issues.js';

// ============================================================
// Issue の置き場所 — 偽の GitHub（Issue とコメント）に対して確かめる
// ============================================================

const CARD_A = {
  id: 'card-a',
  title: '題材 A',
  created: '2026-11-01T00:00:00.000Z',
  skipGates: [],
  branch: null,
  pr: null,
  body: '## アイデア\n本文',
};
const LOG_A = 'card-a.20261101T000000.000Z.plan.submit';
const LOG_A_DATA = {
  cardId: 'card-a',
  at: '2026-11-01T00:00:00.000Z',
  gate: 'plan',
  kind: 'submit',
  reason: '提出します',
};

let github: FakeGithub;
let localDir: string;

beforeEach(() => {
  github = createFakeGithub();
  localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-issue-store-'));
});

afterEach(() => {
  fs.rmSync(localDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function open(dir = localDir): BackedDocumentStore {
  return createIssueDocumentStore({
    owner: 'acme',
    repo: 'board',
    runner: github.runner,
    localDir: dir,
  });
}

/** 始めて、読み込んだ置き場所を返す */
async function opened(): Promise<BackedDocumentStore> {
  const store = open();
  expect(await store.initialize(initialDocuments())).toEqual(ok(undefined));
  expect(await store.check()).toEqual(ok(undefined));
  return store;
}

async function write(store: BackedDocumentStore, fn: () => void): Promise<void> {
  const result = await store.transact('書く', () => {
    fn();
    return Promise.resolve(ok(undefined));
  });
  expect(result).toEqual(ok(undefined));
}

describe('隠しコメント', () => {
  it('`-->` や `<!--` を含む中身でも、末尾の 1 つだけが読まれる', () => {
    const marker = encodeMarker('card', { id: 'a', note: '--> <!-- ai-board:card {} -->' });
    expect(marker.endsWith(' -->')).toBe(true);
    expect(marker.slice(0, -4)).not.toContain('-->');

    const split = splitMarker(`本文 <!-- ai-board:card {"id":"x"} -->\n\n${marker}\n`);
    expect(split?.kind).toBe('card');
    expect(split?.data).toEqual({ id: 'a', note: '--> <!-- ai-board:card {} -->' });
    expect(split?.rest).toBe('本文 <!-- ai-board:card {"id":"x"} -->');
  });

  it('隠しコメントが無い・JSON として読めなければ null', () => {
    expect(splitMarker('ただの本文')).toBeNull();
    expect(splitMarker('<!-- ai-board:card {壊れた} -->')).toBeNull();
  });

  it('カードは本文の末尾に、判断は見出しと理由の後ろに持つ', () => {
    expect(issueFromCard(CARD_A).title).toBe('題材 A');
    expect(issueFromCard(CARD_A).body).toMatch(
      /^## アイデア\n本文\n\n<!-- ai-board:card \{.*\} -->$/
    );
    expect(issueFromCard({ ...CARD_A, body: '' }).body).toMatch(/^<!-- ai-board:card /);

    const comment = commentFromLog(LOG_A, LOG_A_DATA);
    expect(comment).toMatch(
      /^\*\*plan submit\*\* · 2026-11-01T00:00:00.000Z\n\n提出します\n\n<!-- ai-board:log /
    );
  });
});

describe('Issue の置き場所', () => {
  it('始まっていなければ StoreUninitialized、始めた後は形の版が読める', async () => {
    const store = open();
    expect(await store.check()).toEqual(err({ type: 'StoreUninitialized' }));

    expect(await store.initialize(initialDocuments())).toEqual(ok(undefined));
    expect(github.issues).toHaveLength(1);
    expect(github.issues[0]?.labels).toEqual(['ai-board']);
    expect(github.issues[0]?.body).toContain('ai-board:store');

    const other = open();
    expect(await other.check()).toEqual(ok(undefined));
    expect(other.get('board', 'meta')).toEqual({ version: STORE_VERSION });
  });

  it('2 度始めると StoreAlreadyInitialized で、Issue を増やさない', async () => {
    await opened();
    expect(await open().initialize(initialDocuments())).toEqual(
      err({ type: 'StoreAlreadyInitialized' })
    );
    expect(github.issues).toHaveLength(1);
  });

  it('カードは 1 枚 1 Issue になり、別の PC が同じ文書として読む', async () => {
    const store = await opened();
    await write(store, () =>
      store.set('cards', 'card-a', { ...CARD_A, body: '本文 <!-- 隠す --> --> 終わり' })
    );

    const issue = github.issues.find((candidate) => candidate.title === '題材 A');
    expect(issue?.labels).toEqual(['ai-board']);
    expect(issue?.body).toContain('本文 <!-- 隠す --> --> 終わり');

    const other = open(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-issue-store-')));
    expect(await other.check()).toEqual(ok(undefined));
    expect(other.get('cards', 'card-a')).toEqual({
      ...CARD_A,
      body: '本文 <!-- 隠す --> --> 終わり',
    });
  });

  it('判断は Issue のコメントになり、理由が空でも、見出しの行の入った理由でも元に戻る', async () => {
    const store = await opened();
    const logB = 'card-a.20261101T000001.000Z.plan.hold';
    await write(store, () => {
      store.set('cards', 'card-a', CARD_A);
      store.set('log', LOG_A, {
        ...LOG_A_DATA,
        reason: '**太字で始まる**\n\n## 見出し\n- 箇条書き',
      });
      store.set('log', logB, { ...LOG_A_DATA, kind: 'hold', reason: '' });
    });

    const issue = github.issues.find((candidate) => candidate.title === '題材 A');
    expect(issue?.comments).toHaveLength(2);

    const other = open(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-issue-store-')));
    await other.check();
    expect(other.get('log', LOG_A)).toEqual({
      ...LOG_A_DATA,
      reason: '**太字で始まる**\n\n## 見出し\n- 箇条書き',
    });
    expect(other.get('log', logB)).toEqual({ ...LOG_A_DATA, kind: 'hold', reason: '' });
  });

  it('同じ中身を書き直しても API を呼ばず、変えたものだけを PATCH する', async () => {
    const store = await opened();
    await write(store, () => {
      store.set('cards', 'card-a', CARD_A);
      store.set('log', LOG_A, LOG_A_DATA);
    });
    github.calls.length = 0;

    await write(store, () => {
      store.set('cards', 'card-a', CARD_A);
      store.set('log', LOG_A, LOG_A_DATA);
    });
    expect(github.calls.filter((call) => !call.startsWith('graphql'))).toEqual([]);

    github.calls.length = 0;
    await write(store, () => store.set('cards', 'card-a', { ...CARD_A, title: '題材 A（改）' }));
    expect(github.calls.filter((call) => call !== 'graphql')).toEqual([
      'PATCH repos/acme/board/issues/2',
    ]);
    expect(github.issues[1]?.title).toBe('題材 A（改）');
  });

  it('並び順は置き場所の Issue に書き、変わらなければ書かない', async () => {
    const store = await opened();
    const order = { divider: null, ranks: { 'card-a': 1 } };
    await write(store, () => store.set('order', 'order', order));
    expect(github.issues[0]?.body).toContain('"card-a":1');

    github.calls.length = 0;
    await write(store, () => store.set('order', 'order', order));
    expect(github.calls.filter((call) => call !== 'graphql')).toEqual([]);
  });

  it('消したカードの Issue は閉じ、判断のコメントは消す', async () => {
    const store = await opened();
    await write(store, () => {
      store.set('cards', 'card-a', CARD_A);
      store.set('log', LOG_A, LOG_A_DATA);
    });
    await write(store, () => store.delete('log', LOG_A));
    expect(github.issues[1]?.comments).toHaveLength(0);

    await write(store, () => store.delete('cards', 'card-a'));
    expect(github.issues[1]?.state).toBe('closed');
  });

  it('PR の控えとループの記録は GitHub に書かず、手元に置く', async () => {
    const store = await opened();
    github.calls.length = 0;
    await write(store, () => store.set('snapshots', 'card-a', { fingerprint: 'x' }));
    expect(github.calls.filter((call) => call !== 'graphql')).toEqual([]);
    expect(fs.existsSync(path.join(localDir, 'snapshots', 'card-a.json'))).toBe(true);
  });

  it('書き込みの前に読み直し、ほかの PC が先に書いたものの上に書く', async () => {
    const store = await opened();
    const other = open(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-issue-store-')));
    await other.check();
    await write(other, () => other.set('cards', 'card-a', CARD_A));

    await write(store, () => {
      expect(store.get('cards', 'card-a')).toEqual(CARD_A);
      store.set('cards', 'card-b', { ...CARD_A, id: 'card-b', title: '題材 B' });
    });
    expect(github.issues.map((issue) => issue.title)).toContain('題材 B');
    expect(github.issues.filter((issue) => issue.title === '題材 A')).toHaveLength(1);
  });

  it('API が途中で失敗したら StoreApiFailed を返し、次の操作は実際の状態から読み直す', async () => {
    const store = await opened();
    github.failWritesAfter = github.writeCount + 1;
    const result = await store.transact('書く', () => {
      store.set('cards', 'card-a', CARD_A);
      store.set('log', LOG_A, LOG_A_DATA);
      return Promise.resolve(ok(undefined));
    });
    expect(isErr(result) && (result.error as { type: string }).type).toBe('StoreApiFailed');
    expect(github.issues.filter((issue) => issue.title === '題材 A')).toHaveLength(1);

    github.failWritesAfter = null;
    await store.check();
    expect(store.get('cards', 'card-a')).toEqual(CARD_A);
    expect(store.get('log', LOG_A)).toBeNull();
  });

  it('Issues が無効のリポジトリ（HTTP 410）なら、有効にする場所を伝える', async () => {
    const disabled = createIssueDocumentStore({
      owner: 'acme',
      repo: 'board',
      localDir,
      runner: {
        run: (_command, args) =>
          Promise.resolve(
            args.includes('graphql')
              ? ok(
                  '{"data":{"repository":{"issues":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}'
                )
              : err({ type: 'Failed', command: 'gh', message: '失敗', httpStatus: 410 })
          ),
      },
    });

    const result = await disabled.initialize(initialDocuments());
    expect(isErr(result) && (result.error as { message: string }).message).toContain(
      'Settings で Issues を有効'
    );
  });

  it('API が届かなければ check も StoreApiFailed', async () => {
    const result = await createIssueDocumentStore({
      owner: 'acme',
      repo: 'board',
      localDir,
      runner: {
        run: () =>
          Promise.resolve(err({ type: 'Failed', command: 'gh', message: '失敗', httpStatus: 403 })),
      },
    }).check();
    expect(isErr(result) && result.error.type).toBe('StoreApiFailed');
  });
});

describe('Issue の読み込み', () => {
  it('Issue もコメントも複数のページにまたがって読む', async () => {
    const store = await opened();
    await write(store, () => {
      for (const id of ['card-a', 'card-b', 'card-c']) {
        store.set('cards', id, { ...CARD_A, id, title: id });
      }
      for (let n = 0; n < 3; n++) {
        store.set('log', `card-a.2026110${n + 1}T000000.000Z.plan.submit`, {
          ...LOG_A_DATA,
          at: `2026-11-0${n + 1}T00:00:00.000Z`,
        });
      }
    });

    github.pageSize = 1;
    github.commentsInGraphql = 1;
    github.calls.length = 0;
    const other = open(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-issue-store-')));
    expect(await other.check()).toEqual(ok(undefined));
    expect(other.list('cards').map((doc) => doc.id)).toEqual(['card-a', 'card-b', 'card-c']);
    expect(other.list('log')).toHaveLength(3);
    expect(github.calls.filter((call) => call === 'graphql')).toHaveLength(4);
    expect(
      github.calls.some((call) => call.includes('issues/2/comments?per_page=100&page=1'))
    ).toBe(true);
  });

  it('作者が OWNER / MEMBER / COLLABORATOR でないコメントの判断は読まない（承認の偽造）', async () => {
    const store = await opened();
    await write(store, () => store.set('cards', 'card-a', CARD_A));
    const forged = commentFromLog('card-a.20261101T000009.000Z.plan.approve', {
      ...LOG_A_DATA,
      kind: 'approve',
      reason: '承認',
    });
    github.addComment(2, forged, 'NONE');
    github.addComment(2, commentFromLog(LOG_A, LOG_A_DATA), 'COLLABORATOR');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await store.check();
    expect(store.list('log').map((doc) => doc.id)).toEqual([LOG_A]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('OWNER / MEMBER / COLLABORATOR'));
  });

  it('作者が信用できない Issue はカードにしない', async () => {
    await opened();
    github.addIssue({
      title: '外の人の Issue',
      body: issueFromCard({ ...CARD_A, id: 'outsider' }).body,
      authorAssociation: 'NONE',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const store = open();
    await store.check();
    expect(store.list('cards')).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('OWNER / MEMBER / COLLABORATOR'));
  });

  it('別のカードの判断を名乗るコメントは読まない', async () => {
    const store = await opened();
    await write(store, () => {
      store.set('cards', 'card-a', CARD_A);
      store.set('cards', 'card-b', { ...CARD_A, id: 'card-b' });
    });
    github.addComment(3, commentFromLog(LOG_A, LOG_A_DATA));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await store.check();
    expect(store.list('log')).toEqual([]);
  });

  it('隠しコメントが無い・不正なカードの Issue は警告して読み飛ばし、ほかのカードは読む', async () => {
    const store = await opened();
    await write(store, () => store.set('cards', 'card-a', CARD_A));
    github.addIssue({ title: '手で書いた', body: '隠しコメントが無い' });
    github.addIssue({ title: 'ID が不正', body: issueFromCard({ ...CARD_A, id: 'Bad ID' }).body });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await store.check();
    expect(store.list('cards').map((doc) => doc.id)).toEqual(['card-a']);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('同じ ID のカードが 2 つあれば、先の Issue を読む', async () => {
    const store = await opened();
    await write(store, () => store.set('cards', 'card-a', CARD_A));
    github.addIssue({ title: '後から出た同じ ID', body: issueFromCard(CARD_A).body });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await store.check();
    expect(store.get('cards', 'card-a')).toMatchObject({ title: '題材 A' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('先の Issue'));
  });

  it('人が Issue のタイトルを直せば、カードのタイトルとして読む', async () => {
    const store = await opened();
    await write(store, () => store.set('cards', 'card-a', CARD_A));
    const issue = github.issues.find((candidate) => candidate.title === '題材 A');
    if (issue !== undefined) issue.title = '人が直した題材';

    await store.check();
    expect(store.get('cards', 'card-a')).toMatchObject({ title: '人が直した題材' });
  });
});
