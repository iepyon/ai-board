import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { err, ok } from '../../shared/result.js';
import { createCliRunner } from '../cli-runner.js';
import { initialDocuments } from '../document-store.js';
import {
  GitDocumentStore,
  STORE_REF,
  isRemoteName,
  isUpToDate,
  jsonFileCodec,
  parseCatFileBatch,
} from '../git-document-store.js';
import { describeDocumentStoreContract } from './document-store.contract.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-git-store-'));
  dirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

/** 置き場所のリモート（bare）を作る */
function bareRepo(): string {
  const dir = path.join(tempDir(), 'store.git');
  fs.mkdirSync(dir);
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=main');
  return dir;
}

/** コードのリポジトリ（メインのチェックアウトにあたる）を作る */
function codeRepo(): string {
  const dir = path.join(tempDir(), 'repo');
  fs.mkdirSync(dir);
  git(dir, 'init', '--quiet', '--initial-branch=work');
  git(dir, 'config', 'user.name', 'テスト');
  git(dir, 'config', 'user.email', 'test@example.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), 'コード\n');
  git(dir, 'add', 'README.md');
  git(dir, 'commit', '--quiet', '-m', 'init');
  return dir;
}

const runner = createCliRunner({ timeoutMs: 20_000, maxBuffer: 64 * 1024 * 1024 });

function makeStore(remote: string, repoDir = codeRepo()): GitDocumentStore {
  return new GitDocumentStore({
    repoDir,
    remote,
    branch: 'main',
    localDir: path.join(path.dirname(repoDir), `local-${path.basename(repoDir)}`),
    localCollections: ['snapshots', 'loop'],
    codec: jsonFileCodec('.ai-board'),
    runner,
  });
}

async function initializedStore(remote = bareRepo()): Promise<GitDocumentStore> {
  const store = makeStore(remote);
  expect(await store.initialize(initialDocuments())).toEqual(ok(undefined));
  return store;
}

function remoteHead(bare: string): string {
  return git(bare, 'rev-parse', 'main').trim();
}

describeDocumentStoreContract('git', () => initializedStore());

describe('GitDocumentStore', () => {
  it('空の置き場所は未初期化と読み、init は親の無いコミットを作り、2 度目は拒む', async () => {
    const bare = bareRepo();
    const store = makeStore(bare);
    expect(await store.check()).toEqual(err({ type: 'StoreUninitialized' }));

    expect(await store.initialize(initialDocuments())).toEqual(ok(undefined));
    expect(git(bare, 'ls-tree', '-r', '--name-only', 'main').trim()).toBe(
      '.ai-board/board/meta.json'
    );
    expect(git(bare, 'rev-list', '--count', 'main').trim()).toBe('1');

    expect(await store.initialize(initialDocuments())).toEqual(
      err({ type: 'StoreAlreadyInitialized' })
    );
  });

  it('書き込みは置き場所のブランチへのコミットになり、作業ツリー・index・今のブランチを変えない', async () => {
    const bare = bareRepo();
    const repo = codeRepo();
    const store = makeStore(bare, repo);
    await store.initialize(initialDocuments());
    fs.writeFileSync(path.join(repo, 'README.md'), '書きかけ\n');
    const before = {
      status: git(repo, 'status', '--porcelain'),
      head: git(repo, 'rev-parse', 'HEAD'),
      branch: git(repo, 'branch', '--show-current'),
    };

    await store.check();
    const result = await store.transact('カードを書く', () => {
      store.set('cards', 'a', { title: 'A' });
      return Promise.resolve(ok(undefined));
    });

    expect(result).toEqual(ok(undefined));
    expect(git(bare, 'show', 'main:.ai-board/cards/a.json')).toBe('{"title":"A"}\n');
    expect(git(bare, 'log', '-1', '--format=%s', 'main').trim()).toBe('chore(board): カードを書く');
    expect({
      status: git(repo, 'status', '--porcelain'),
      head: git(repo, 'rev-parse', 'HEAD'),
      branch: git(repo, 'branch', '--show-current'),
    }).toEqual(before);
    expect(git(repo, 'rev-parse', STORE_REF).trim()).toBe(remoteHead(bare));
  });

  it('push が先を越されたら、取り直した置き場所の上で op を走らせ直し、両方の変更が残る', async () => {
    const bare = bareRepo();
    const mine = await initializedStore(bare);
    const theirs = makeStore(bare);
    await mine.check();
    await theirs.check();

    await theirs.transact('先に書く', () => {
      theirs.set('order', 'order', { ranks: { a: 1 } });
      return Promise.resolve(ok(undefined));
    });

    let calls = 0;
    const result = await mine.transact('後から書く', () => {
      calls++;
      // 走らせ直したときは、相手の書き込みが見えている
      const order = mine.get('order', 'order');
      mine.set('cards', 'b', { sawOrder: order !== null });
      return Promise.resolve(ok(calls));
    });

    expect(result).toEqual(ok(2));
    expect(git(bare, 'show', 'main:.ai-board/order/order.json')).toBe('{"ranks":{"a":1}}\n');
    expect(git(bare, 'show', 'main:.ai-board/cards/b.json')).toBe('{"sawOrder":true}\n');
  });

  it('git に載せないコレクションだけの書き込みでは push せず、手元のファイルに書く', async () => {
    const bare = bareRepo();
    const repo = codeRepo();
    const store = makeStore(bare, repo);
    await store.initialize(initialDocuments());
    await store.check();
    const head = remoteHead(bare);

    await store.transact('ループの記録', () => {
      store.set('loop', 'r1', { result: null });
      return Promise.resolve(ok(undefined));
    });
    await store.transact('何も書かない', () => Promise.resolve(ok(undefined)));

    expect(remoteHead(bare)).toBe(head);
    expect(store.get('loop', 'r1')).toEqual({ result: null });
    const reopened = makeStore(bare, repo);
    expect(await reopened.check()).toEqual(ok(undefined));
    expect(reopened.get('loop', 'r1')).toEqual({ result: null });
  });

  it('消した文書は置き場所のファイルからも消える', async () => {
    const bare = bareRepo();
    const store = await initializedStore(bare);
    await store.check();
    await store.transact('書く', () => {
      store.set('cards', 'a', { title: 'A' });
      return Promise.resolve(ok(undefined));
    });
    await store.transact('消す', () => {
      store.delete('cards', 'a');
      return Promise.resolve(ok(undefined));
    });

    expect(git(bare, 'ls-tree', '-r', '--name-only', 'main').trim()).toBe(
      '.ai-board/board/meta.json'
    );
  });

  it('リモートの名前がリポジトリに無ければ StoreRemoteMissing', async () => {
    const store = makeStore('nowhere');
    expect(await store.check()).toEqual(err({ type: 'StoreRemoteMissing', remote: 'nowhere' }));
  });

  it('置き場所に届かなければ StoreGitFailed', async () => {
    const store = makeStore(path.join(tempDir(), 'missing.git'));
    const checked = await store.check();
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error.type).toBe('StoreGitFailed');
  });
});

describe('isUpToDate', () => {
  it('push の ref の行が = なら既に最新', () => {
    expect(isUpToDate('To /x/store.git\n=\tabc:refs/heads/main\t[up to date]\nDone\n')).toBe(true);
    expect(isUpToDate('To /x/store.git\n \tabc:refs/heads/main\t1..2\nDone\n')).toBe(false);
  });
});

describe('isRemoteName', () => {
  it('名前とパス・URL を分ける', () => {
    expect(isRemoteName('origin')).toBe(true);
    expect(isRemoteName('/tmp/store.git')).toBe(false);
    expect(isRemoteName('../store.git')).toBe(false);
    expect(isRemoteName('https://example.invalid/a.git')).toBe(false);
  });
});

describe('parseCatFileBatch', () => {
  it('見出しのバイト数で、マルチバイトの中身を切り出す', () => {
    const a = 'あい\n';
    const b = 'x';
    const output =
      `aaa blob ${Buffer.byteLength(a)}\n${a}\n` + `bbb blob ${Buffer.byteLength(b)}\n${b}\n`;
    expect(parseCatFileBatch(output)).toEqual([a, b]);
  });
});
