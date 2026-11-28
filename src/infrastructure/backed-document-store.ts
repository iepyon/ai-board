import * as fs from 'node:fs';
import * as path from 'node:path';
import { err, isErr, ok, type Result } from '../shared/result.js';
import { compareStrings } from '../shared/compare.js';
import {
  assertWritable,
  checkMeta,
  isValidDocumentId,
  labelOf,
  type Collection,
  type DocumentData,
  type DocumentStore,
  type StoredDocument,
  type StoreError,
  type TransactLabel,
} from './document-store.js';
import { defaultLockOptions, withFileLock, type LockOptions } from './file-lock.js';

// ============================================================
// 共有の置き場所の土台 — ロック・読み直し・書き込みの集め方を 1 か所に置く
// ============================================================

/** 共有の文書の鍵。`<コレクション>/<ID>` */
export function keyOf(collection: Collection, id: string): string {
  return `${collection}/${id}`;
}

export function parseKey(key: string): { collection: Collection; id: string } {
  const at = key.indexOf('/');
  return { collection: key.slice(0, at) as Collection, id: key.slice(at + 1) };
}

export const DELETED = Symbol('deleted');
export type Written = DocumentData | typeof DELETED;

/**
 * 共有の文書の置き場所そのもの（GitHub の Issue、試しのディレクトリ など）。
 *
 * 手元のコレクション（`localCollections`）は土台が手元の JSON に置くので、ここには来ない。
 */
export interface StoreBackend {
  /** 共有の文書を全部読み直す。鍵は `keyOf(collection, id)` */
  load(): Promise<Result<Map<string, DocumentData>, StoreError>>;
  /**
   * 書き込みを確定する。`before` は書き込む前に `load` が返した文書。`label` は書き込みの 1 操作の名前
   * （履歴を持つ置き場所は題にできる。Issue は使わない）。
   * 途中で失敗したら Err を返す（確定した分は戻さない。土台は次の操作で読み直す）
   */
  apply(
    writes: ReadonlyMap<string, Written>,
    before: ReadonlyMap<string, DocumentData>,
    label: string
  ): Promise<Result<void, StoreError>>;
}

export interface BackedDocumentStoreOptions {
  readonly backend: StoreBackend;
  /** 手元だけの文書・ロックを置くディレクトリ */
  readonly localDir: string;
  /** 共有せず、`localDir` に JSON で置くコレクション */
  readonly localCollections: readonly Collection[];
  readonly lockOptions?: LockOptions;
}

/** 書き込みの 1 操作が、ほかの PC の書き込みを待つ上限。ロックは API の呼び出しをまたいで持つ */
export const BACKED_STORE_LOCK_OPTIONS: LockOptions = { ...defaultLockOptions, timeoutMs: 300_000 };

const LOCK_FILE = 'store.lock';

/**
 * 共有の文書を `StoreBackend` に、手元の文書を `localDir` に置く `DocumentStore`。
 *
 * - `check()` はロックを取って共有の文書を読み直し、形の版を確かめる。`get` / `list` はこの読み込みから返す
 * - `transact` はロックを取り、**読み直してから** `op` を走らせる（ほかの PC が先に書いたものの上に書く）。
 *   `op` が Ok を返したら、共有の書き込みを `backend.apply` で確定し、手元の書き込みを JSON に書く
 * - 外部への書き込みが無ければ（手元だけ・何も書かない）、`apply` を呼ばない
 */
export class BackedDocumentStore implements DocumentStore {
  private readonly lockPath: string;
  private readonly lockOptions: LockOptions;
  private docs = new Map<string, DocumentData>();
  private written: Map<string, Written> | null = null;

  constructor(private readonly options: BackedDocumentStoreOptions) {
    this.lockPath = path.join(options.localDir, LOCK_FILE);
    this.lockOptions = options.lockOptions ?? BACKED_STORE_LOCK_OPTIONS;
  }

  async check(): Promise<Result<void, StoreError>> {
    const loaded = await this.locked(() => this.load());
    if (isErr(loaded)) return loaded;
    if (isErr(loaded.value)) return loaded.value;
    return checkMeta(this);
  }

  get(collection: Collection, id: string): DocumentData | null {
    const key = keyOf(collection, id);
    const written = this.written?.get(key);
    if (written === DELETED) return null;
    return written ?? this.docs.get(key) ?? null;
  }

  list(collection: Collection): readonly StoredDocument[] {
    const ids = new Set<string>();
    const prefix = `${collection}/`;
    for (const key of this.docs.keys())
      if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
    for (const key of this.written?.keys() ?? []) {
      if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
    }
    return [...ids].sort(compareStrings).flatMap((id) => {
      const data = this.get(collection, id);
      return data === null ? [] : [{ id, data }];
    });
  }

  set(collection: Collection, id: string, data: DocumentData): void {
    assertWritable(collection, id);
    this.requireWritten().set(keyOf(collection, id), structuredClone(data));
  }

  delete(collection: Collection, id: string): void {
    assertWritable(collection, id);
    const written = this.requireWritten();
    if (this.get(collection, id) === null) return;
    written.set(keyOf(collection, id), DELETED);
  }

  /** 書き込みの 1 操作。形の版（`board/meta`）が合わなければ `op` を走らせない */
  transact<T, E>(
    label: TransactLabel<T>,
    op: () => Promise<Result<T, E>>
  ): Promise<Result<T, E | StoreError>> {
    return this.transactWith(label, op, true);
  }

  /**
   * 空の置き場所に最初の文書を書く（`ai-board store init`）。既に `board/meta` があれば `StoreAlreadyInitialized`。
   * 確かめは書き込みの 1 操作の中（ロックを取って読み直した後）で行う
   */
  initialize(
    docs: readonly { collection: Collection; id: string; data: DocumentData }[]
  ): Promise<Result<void, StoreError>> {
    return this.transactWith<void, StoreError>(
      '置き場所を始める',
      () => {
        if (this.get('board', 'meta') !== null) {
          return Promise.resolve(err({ type: 'StoreAlreadyInitialized' }));
        }
        for (const doc of docs) this.set(doc.collection, doc.id, doc.data);
        return Promise.resolve(ok(undefined));
      },
      false
    );
  }

  private async transactWith<T, E>(
    label: TransactLabel<T>,
    op: () => Promise<Result<T, E>>,
    requireMeta: boolean
  ): Promise<Result<T, E | StoreError>> {
    const locked = await this.locked(async (): Promise<Result<T, E | StoreError>> => {
      const loaded = await this.load();
      if (isErr(loaded)) return loaded;
      if (requireMeta) {
        const checked = checkMeta(this);
        if (isErr(checked)) return checked;
      }

      const written = new Map<string, Written>();
      this.written = written;
      let result: Result<T, E>;
      try {
        result = await op();
      } finally {
        this.written = null;
      }
      if (!result.ok) return result;

      const settled = await this.settle(labelOf(label, result.value), written);
      if (isErr(settled)) {
        return settled;
      }
      return result;
    });
    if (isErr(locked)) return locked;
    return locked.value;
  }

  /** 共有の書き込みを `backend` へ、手元の書き込みを JSON へ。確定したら読み込みへ反映する */
  private async settle(
    label: string,
    written: Map<string, Written>
  ): Promise<Result<void, StoreError>> {
    const shared = new Map<string, Written>();
    const local = new Map<string, Written>();
    for (const [key, value] of written) {
      const { collection } = parseKey(key);
      (this.options.localCollections.includes(collection) ? local : shared).set(key, value);
    }

    if (shared.size > 0) {
      const applied = await this.options.backend.apply(shared, this.docs, label);
      if (isErr(applied)) return applied;
    }
    await writeJsonDir(this.options.localDir, local);
    for (const [key, value] of written) {
      if (value === DELETED) this.docs.delete(key);
      else this.docs.set(key, value);
    }
    return ok(undefined);
  }

  /** 共有の文書と手元の文書を全部読み直す。ロックの中で呼ぶ */
  private async load(): Promise<Result<void, StoreError>> {
    const shared = await this.options.backend.load();
    if (isErr(shared)) return shared;
    const docs = new Map(shared.value);
    for (const doc of readLocal(this.options.localDir, this.options.localCollections)) {
      docs.set(keyOf(doc.collection, doc.id), doc.data);
    }
    this.docs = docs;
    return ok(undefined);
  }

  private async locked<T>(op: () => Promise<T>): Promise<Result<T, StoreError>> {
    fs.mkdirSync(this.options.localDir, { recursive: true });
    const result = await withFileLock(this.lockPath, this.lockOptions, op);
    if (isErr(result)) return err({ type: 'StoreLockTimeout', lockPath: result.error.lockPath });
    return result;
  }

  private requireWritten(): Map<string, Written> {
    if (this.written === null) throw new Error('書き込みは transact の中でだけ行えます');
    return this.written;
  }
}

// ------------------------------------------------------------
// 手元の文書（`<localDir>/<コレクション>/<ID>.json`）
// ------------------------------------------------------------

function readLocal(
  localDir: string,
  collections: readonly Collection[]
): { collection: Collection; id: string; data: DocumentData }[] {
  const docs: { collection: Collection; id: string; data: DocumentData }[] = [];
  for (const collection of collections) {
    docs.push(...readJsonDir(path.join(localDir, collection), collection));
  }
  return docs;
}

/** `dir` の `<ID>.json` を文書として読む。読めないものは警告して読み飛ばす */
export function readJsonDir(
  dir: string,
  collection: Collection
): { collection: Collection; id: string; data: DocumentData }[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const docs: { collection: Collection; id: string; data: DocumentData }[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!isValidDocumentId(id)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as unknown;
      if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
        docs.push({ collection, id, data: data as DocumentData });
      }
    } catch {
      console.warn(`[ai-board] 手元の文書を読み飛ばしました: ${path.join(dir, name)}`);
    }
  }
  return docs;
}

/** 書き込みを `<root>/<コレクション>/<ID>.json` へ。置き換えは一時ファイルからの rename */
export async function writeJsonDir(
  root: string,
  writes: ReadonlyMap<string, Written>
): Promise<void> {
  for (const [key, value] of writes) {
    const { collection, id } = parseKey(key);
    const dir = path.join(root, collection);
    const file = path.join(dir, `${id}.json`);
    if (value === DELETED) {
      await fs.promises.rm(file, { force: true });
      continue;
    }
    await fs.promises.mkdir(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
    await fs.promises.rename(temp, file);
  }
}
