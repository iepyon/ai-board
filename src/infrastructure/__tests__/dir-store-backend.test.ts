import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ok } from '../../shared/result.js';
import { createDirDocumentStore } from '../dir-store-backend.js';
import { initialDocuments } from '../document-store.js';
import { describeDocumentStoreContract } from './document-store.contract.js';

// ============================================================
// 試しの置き場所 — ディレクトリの JSON
// ============================================================

const roots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-dir-store-'));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

describeDocumentStoreContract('ディレクトリ', async () => {
  const root = makeRoot();
  const store = createDirDocumentStore({
    dir: path.join(root, 'store'),
    localDir: path.join(root, 'local'),
  });
  expect(await store.initialize(initialDocuments())).toEqual(ok(undefined));
  return store;
});

describe('ディレクトリの置き場所', () => {
  it('共有の文書は dir に、PR の控えとループの記録は localDir に置く', async () => {
    const root = makeRoot();
    const store = createDirDocumentStore({
      dir: path.join(root, 'store'),
      localDir: path.join(root, 'local'),
    });
    await store.initialize(initialDocuments());
    await store.transact('書く', () => {
      store.set('cards', 'a', { title: 'A' });
      store.set('snapshots', 'a', { fingerprint: 'x' });
      return Promise.resolve(ok(undefined));
    });

    expect(fs.existsSync(path.join(root, 'store', 'cards', 'a.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'store', 'snapshots'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'local', 'snapshots', 'a.json'))).toBe(true);
  });

  it('同じディレクトリを別に開いても、書いたものが読める', async () => {
    const root = makeRoot();
    const options = { dir: path.join(root, 'store'), localDir: path.join(root, 'local') };
    const first = createDirDocumentStore(options);
    await first.initialize(initialDocuments());
    await first.transact('書く', () => {
      first.set('cards', 'a', { title: 'A' });
      return Promise.resolve(ok(undefined));
    });

    const second = createDirDocumentStore(options);
    expect(await second.check()).toEqual(ok(undefined));
    expect(second.get('cards', 'a')).toEqual({ title: 'A' });
  });
});
