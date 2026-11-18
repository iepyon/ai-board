import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { err, isErr, ok } from '../../shared/result.js';
import {
  ArtifactMirrorStore,
  BATCH_LIMIT,
  parsePhysicalFile,
  physicalId,
} from '../artifact-mirror-store.js';
import { STORE_VERSION } from '../document-store.js';
import { describeDocumentStoreContract } from './document-store.contract.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-store-'));
  dirs.push(dir);
  return dir;
}

/** `ArtifactData` の out_dir が書く形のディレクトリを作る */
function writeExport(dir: string, docs: Record<string, Record<string, unknown>>): string {
  for (const [file, data] of Object.entries(docs)) {
    const full = path.join(dir, `${file}.json`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(data, null, 2));
  }
  return dir;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

/** board/meta だけを取り込んだ置き場所 */
function pulledStore(): ArtifactMirrorStore {
  const root = tempDir();
  const store = new ArtifactMirrorStore(path.join(root, 'store'));
  const exportDir = writeExport(path.join(root, 'export'), {
    'board/meta~000001': { version: STORE_VERSION },
  });
  fs.mkdirSync(store.mirrorDir, { recursive: true });
  for (const name of ['board']) {
    fs.cpSync(path.join(exportDir, name), path.join(store.mirrorDir, name), { recursive: true });
  }
  return store;
}

describeDocumentStoreContract('Artifact の DB（写しと送る箱）', pulledStore);

describe('ArtifactMirrorStore', () => {
  it('写しが無いときは transact が書かない（空の置き場所は initialize で始める）', async () => {
    const store = new ArtifactMirrorStore(path.join(tempDir(), 'store'));
    const refused = await store.transact('書く', () => {
      store.set('cards', 'a', { title: 'A' });
      return Promise.resolve(ok(undefined));
    });
    expect(refused).toEqual(err({ type: 'StoreNotPulled', mirrorDir: store.mirrorDir }));
    expect(store.pendingWrites()).toBe(0);

    expect(await store.initialize()).toEqual(ok(true));
    expect(store.check()).toEqual(ok(undefined));
    expect(store.outbox().map((batch) => batch.writes.map((w) => w.doc_id))).toEqual([
      ['meta~000001'],
    ]);
    // 既に始まっていれば何も積まない
    expect(await store.initialize()).toEqual(ok(false));
    expect(store.pendingWrites()).toBe(1);
  });

  it('読めない改訂があれば check が取り込み直しを促し、連番はその改訂の次から振る', async () => {
    const store = pulledStore();
    await store.transact('1', () => {
      store.set('cards', 'a', { title: 'A' });
      return Promise.resolve(ok(undefined));
    });
    await store.ack('999999');
    // 書きかけで壊れた改訂
    const broken = path.join(store.mirrorDir, 'cards', 'a~000002.json');
    fs.writeFileSync(broken, '{ "title": ');
    const reopened = new ArtifactMirrorStore(store.storeDir);

    const checked = reopened.check();
    expect(isErr(checked) && checked.error).toMatchObject({
      type: 'StoreInvalidDocument',
      path: broken,
    });
    expect(reopened.get('cards', 'a')).toBeNull();

    const refused = await reopened.transact<undefined, never>('2', () =>
      Promise.resolve(ok(undefined))
    );
    expect(isErr(refused) && refused.error.type).toBe('StoreInvalidDocument');
  });

  it('ack は連番が --through 以下の束だけを消す', async () => {
    const store = pulledStore();
    for (const id of ['a', 'b', 'c']) {
      await store.transact(id, () => {
        store.set('cards', id, { title: id });
        return Promise.resolve(ok(undefined));
      });
    }
    expect(store.outbox().map((batch) => batch.seq)).toEqual(['000001', '000002', '000003']);

    expect(await store.ack('000002')).toEqual(ok(2));

    expect(store.outbox().map((batch) => batch.label)).toEqual(['c']);
    expect(fs.readdirSync(path.join(store.outboxDir, 'docs'))).toEqual(['000003-1.json']);
  });

  it('写しが無ければ check が取り込みを促す', () => {
    const store = new ArtifactMirrorStore(path.join(tempDir(), 'store'));
    expect(store.check()).toEqual(err({ type: 'StoreNotPulled', mirrorDir: store.mirrorDir }));
  });

  it('pull で out_dir の書き出しを写しに入れ、論理 ID ごとに最新の改訂を読む', async () => {
    const root = tempDir();
    const store = new ArtifactMirrorStore(path.join(root, 'store'));
    const exportDir = writeExport(path.join(root, 'export'), {
      'board/meta~000001': { version: STORE_VERSION },
      'cards/a~000001': { title: '古い' },
      'cards/a~000002': { title: '新しい' },
      'cards/b~000001': { title: 'B' },
      'cards/b~000002': { __deleted: true },
    });

    const result = await store.pull(exportDir);

    expect(result).toEqual(ok({ count: 5 }));
    expect(store.check()).toEqual(ok(undefined));
    expect(store.get('cards', 'a')).toEqual({ title: '新しい' });
    expect(store.get('cards', 'b')).toBeNull();
    expect(store.list('cards').map((doc) => doc.id)).toEqual(['a']);
  });

  it('pull は写しを丸ごと入れ替える（取り込み元に無い文書は消える）', async () => {
    const root = tempDir();
    const store = new ArtifactMirrorStore(path.join(root, 'store'));
    await store.pull(
      writeExport(path.join(root, 'e1'), {
        'board/meta~000001': { version: STORE_VERSION },
        'cards/a~000001': { title: 'A' },
      })
    );
    await store.pull(
      writeExport(path.join(root, 'e2'), { 'board/meta~000001': { version: STORE_VERSION } })
    );
    expect(store.get('cards', 'a')).toBeNull();
  });

  it('pull は読めない文書が 1 つでもあれば何も変えない', async () => {
    const root = tempDir();
    const store = new ArtifactMirrorStore(path.join(root, 'store'));
    await store.pull(
      writeExport(path.join(root, 'e1'), {
        'board/meta~000001': { version: STORE_VERSION },
        'cards/a~000001': { title: 'A' },
      })
    );
    const bad = path.join(root, 'e2');
    writeExport(bad, { 'board/meta~000001': { version: STORE_VERSION } });
    fs.mkdirSync(path.join(bad, 'cards'), { recursive: true });
    fs.writeFileSync(path.join(bad, 'cards', 'a~000002.json'), '[1, 2]');

    const result = await store.pull(bad);

    expect(isErr(result) && result.error.type).toBe('StoreInvalidDocument');
    expect(store.get('cards', 'a')).toEqual({ title: 'A' });
  });

  it('pull は改訂の形でない名前のファイルを拒む', async () => {
    const root = tempDir();
    const store = new ArtifactMirrorStore(path.join(root, 'store'));
    const result = await store.pull(
      writeExport(path.join(root, 'e'), { 'cards/a': { title: 'A' } })
    );
    expect(isErr(result) && result.error.type).toBe('StoreInvalidDocument');
  });

  it('pull は規定外のコレクションを読まない', async () => {
    const root = tempDir();
    const store = new ArtifactMirrorStore(path.join(root, 'store'));
    const result = await store.pull(
      writeExport(path.join(root, 'e'), {
        'board/meta~000001': { version: STORE_VERSION },
        'other/x~000001': { a: 1 },
      })
    );
    expect(result).toEqual(ok({ count: 1 }));
  });

  it('書き換えは次の改訂を作り、送る箱に新しい文書の作成として積む', async () => {
    const store = pulledStore();
    await store.transact('1', () => {
      store.set('cards', 'a', { title: 'A' });
      return Promise.resolve(ok(undefined));
    });
    await store.transact('2', () => {
      store.set('cards', 'a', { title: 'B' });
      store.set('log', 'a.1', { kind: 'submit' });
      return Promise.resolve(ok(undefined));
    });

    expect(fs.readdirSync(path.join(store.mirrorDir, 'cards')).sort()).toEqual([
      'a~000001.json',
      'a~000002.json',
    ]);
    expect(store.pendingWrites()).toBe(2);

    const batches = store.outbox();
    expect(batches.map((batch) => batch.label)).toEqual(['1', '2']);
    expect(batches[1]?.writes).toEqual([
      {
        op: 'set',
        collection: 'cards',
        doc_id: 'a~000002',
        file_path: path.join(store.outboxDir, 'docs', '000002-1.json'),
      },
      {
        op: 'set',
        collection: 'log',
        doc_id: 'a.1~000001',
        file_path: path.join(store.outboxDir, 'docs', '000002-2.json'),
      },
    ]);
    expect(readJson(batches[1]?.writes[0]?.file_path ?? '')).toEqual({ title: 'B' });
    for (const write of batches.flatMap((batch) => batch.writes)) {
      expect(write).not.toHaveProperty('if_version');
    }
  });

  it('同じ transact で同じ文書を 2 回書いても改訂は 1 つ', async () => {
    const store = pulledStore();
    await store.transact('1', () => {
      store.set('cards', 'a', { title: 'A' });
      store.set('cards', 'a', { title: 'B' });
      return Promise.resolve(ok(undefined));
    });
    expect(store.outbox()[0]?.writes.map((write) => write.doc_id)).toEqual(['a~000001']);
    expect(store.get('cards', 'a')).toEqual({ title: 'B' });
  });

  it('消すと消したことを表す改訂を積む', async () => {
    const store = pulledStore();
    await store.transact('1', () => {
      store.set('cards', 'a', { title: 'A' });
      return Promise.resolve(ok(undefined));
    });
    await store.ack('999999');
    await store.transact('2', () => {
      store.delete('cards', 'a');
      return Promise.resolve(ok(undefined));
    });
    const write = store.outbox()[0]?.writes[0];
    expect(write?.doc_id).toBe('a~000002');
    expect(readJson(write?.file_path ?? '')).toEqual({ __deleted: true });
  });

  it('中身に __deleted を使うと呼び出し側の誤りとして例外を投げる', async () => {
    const store = pulledStore();
    await expect(
      store.transact('誤り', () => {
        store.set('cards', 'a', { __deleted: true });
        return Promise.resolve(ok(undefined));
      })
    ).rejects.toThrow();
  });

  it('拒んだ transact は写しにも送る箱にも何も残さない', async () => {
    const store = pulledStore();
    await store.transact('拒む', () => {
      store.set('cards', 'a', { title: 'A' });
      return Promise.resolve(err('no'));
    });
    expect(fs.existsSync(path.join(store.mirrorDir, 'cards', 'a~000001.json'))).toBe(false);
    expect(store.pendingWrites()).toBe(0);
  });

  it('何も書かない transact は送る箱に束を作らない', async () => {
    const store = pulledStore();
    await store.transact('読むだけ', () => Promise.resolve(ok(store.get('cards', 'a'))));
    expect(store.pendingWrites()).toBe(0);
  });

  it('50 件を超える束は 50 件ずつに分けて出す', async () => {
    const store = pulledStore();
    await store.transact('多い', () => {
      for (let i = 0; i < BATCH_LIMIT + 3; i += 1) store.set('log', `x.${i}`, { i });
      return Promise.resolve(ok(undefined));
    });
    const sizes = store.outbox().map((batch) => batch.writes.length);
    expect(sizes).toEqual([BATCH_LIMIT, 3]);
    expect(store.pendingWrites()).toBe(1);
  });

  it('送る箱があるうちは pull を拒み、写しを変えない', async () => {
    const root = tempDir();
    const store = pulledStore();
    await store.transact('1', () => {
      store.set('cards', 'a', { title: 'A' });
      return Promise.resolve(ok(undefined));
    });
    const result = await store.pull(
      writeExport(path.join(root, 'e'), { 'board/meta~000001': { version: STORE_VERSION } })
    );
    expect(result).toEqual(err({ type: 'StorePendingWrites', count: 1 }));
    expect(store.get('cards', 'a')).toEqual({ title: 'A' });
  });

  it('ack は送る箱を空にし、写しはそのまま残す', async () => {
    const store = pulledStore();
    await store.transact('1', () => {
      store.set('cards', 'a', { title: 'A' });
      return Promise.resolve(ok(undefined));
    });
    expect(await store.ack('999999')).toEqual(ok(1));
    expect(store.pendingWrites()).toBe(0);
    expect(store.get('cards', 'a')).toEqual({ title: 'A' });
  });

  it('discard は送る箱を捨て、写しを積む前に戻す', async () => {
    const store = pulledStore();
    await store.transact('1', () => {
      store.set('cards', 'a', { title: 'A' });
      return Promise.resolve(ok(undefined));
    });
    await store.ack('999999');
    await store.transact('2', () => {
      store.set('cards', 'a', { title: 'B' });
      store.set('log', 'a.1', { kind: 'submit' });
      return Promise.resolve(ok(undefined));
    });

    expect(await store.discard()).toEqual(ok(1));

    expect(store.pendingWrites()).toBe(0);
    expect(store.get('cards', 'a')).toEqual({ title: 'A' });
    expect(store.get('log', 'a.1')).toBeNull();
  });

  it('ほかのプロセスが写しに足した改訂を、次の transact で読み直す', async () => {
    const store = pulledStore();
    const other = new ArtifactMirrorStore(store.storeDir);
    expect(store.get('cards', 'a')).toBeNull();
    await other.transact('別', () => {
      other.set('cards', 'a', { title: '別' });
      return Promise.resolve(ok(undefined));
    });
    await store.transact('続き', () => {
      store.set('cards', 'a', { title: `${String(store.get('cards', 'a')?.title)}+` });
      return Promise.resolve(ok(undefined));
    });
    expect(store.get('cards', 'a')).toEqual({ title: '別+' });
    expect(store.outbox().map((batch) => batch.writes[0]?.doc_id)).toEqual([
      'a~000001',
      'a~000002',
    ]);
  });

  it('ロックを待ち切れなければ StoreLockTimeout', async () => {
    const store = pulledStore();
    const lockPath = path.join(store.storeDir, 'store.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'x', at: '' }));
    const quick = new ArtifactMirrorStore(store.storeDir, {
      timeoutMs: 30,
      pollMs: 5,
      isAlive: () => true,
    });
    const result = await quick.transact('待つ', () => Promise.resolve(ok(undefined)));
    expect(result).toEqual(err({ type: 'StoreLockTimeout', lockPath }));
  });
});

describe('physicalId / parsePhysicalFile', () => {
  it('論理 ID と連番を行き来する', () => {
    expect(physicalId('card-a', 7)).toBe('card-a~000007');
    expect(parsePhysicalFile('card-a~000007.json')).toEqual({ id: 'card-a', rev: 7 });
    expect(parsePhysicalFile('a.2026.plan.submit~000001.json')).toEqual({
      id: 'a.2026.plan.submit',
      rev: 1,
    });
  });

  it.each([
    'a.json',
    'a~1.json',
    'a~000000.json',
    '~000001.json',
    'a~000001.txt',
    'あ~000001.json',
  ])('%s は読み分けない', (name) => {
    expect(parsePhysicalFile(name)).toBeNull();
  });
});
