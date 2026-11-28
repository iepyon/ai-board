import * as fs from 'node:fs';
import * as path from 'node:path';
import { ok, type Result } from '../shared/result.js';
import {
  COLLECTIONS,
  type Collection,
  type DocumentData,
  type StoreError,
} from './document-store.js';
import {
  BackedDocumentStore,
  keyOf,
  readJsonDir,
  writeJsonDir,
  type StoreBackend,
  type Written,
} from './backed-document-store.js';
import type { LockOptions } from './file-lock.js';

// ============================================================
// 試しの置き場所 — 共有の文書を手元のディレクトリの JSON に置く
// ============================================================

/**
 * 共有の文書を `<dir>/<コレクション>/<ID>.json` に置く。GitHub に何も書かずに、カードの書き込みを試すための置き場所。
 * `AI_BOARD_STORE` にディレクトリを指すと、本物の Issue の代わりにこれを使う。
 */
export class DirStoreBackend implements StoreBackend {
  constructor(
    private readonly dir: string,
    private readonly localCollections: readonly Collection[]
  ) {}

  load(): Promise<Result<Map<string, DocumentData>, StoreError>> {
    const docs = new Map<string, DocumentData>();
    for (const collection of COLLECTIONS) {
      if (this.localCollections.includes(collection)) continue;
      for (const doc of readJsonDir(path.join(this.dir, collection), collection)) {
        docs.set(keyOf(doc.collection, doc.id), doc.data);
      }
    }
    return Promise.resolve(ok(docs));
  }

  async apply(writes: ReadonlyMap<string, Written>): Promise<Result<void, StoreError>> {
    fs.mkdirSync(this.dir, { recursive: true });
    await writeJsonDir(this.dir, writes);
    return ok(undefined);
  }
}

/** 手元に置くコレクション。PR の控えとループの記録は共有しない */
export const LOCAL_COLLECTIONS: readonly Collection[] = ['snapshots', 'loop'];

/** 試しの置き場所（ディレクトリ）の `DocumentStore`。手元の文書・ロックは `localDir` に置く */
export function createDirDocumentStore(options: {
  readonly dir: string;
  readonly localDir: string;
  readonly lockOptions?: LockOptions;
}): BackedDocumentStore {
  return new BackedDocumentStore({
    backend: new DirStoreBackend(options.dir, LOCAL_COLLECTIONS),
    localDir: options.localDir,
    localCollections: LOCAL_COLLECTIONS,
    ...(options.lockOptions === undefined ? {} : { lockOptions: options.lockOptions }),
  });
}
