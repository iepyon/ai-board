import * as fs from 'node:fs';
import * as path from 'node:path';
import { err, isErr, ok, type Result } from '../shared/result.js';
import {
  assertWritable,
  checkMeta,
  COLLECTIONS,
  isValidDocumentId,
  type Collection,
  type DocumentData,
  type DocumentStore,
  type StoredDocument,
  type StoreError,
  type TransactLabel,
  labelOf,
} from './document-store.js';
import { defaultLockOptions, withFileLock, type LockOptions } from './file-lock.js';

// ============================================================
// Artifact の DB の実装 — 手元の写しを読み、書き込みは送る箱に積む
// ============================================================

/**
 * node の CLI は Artifact の DB に届かない（読み書きできるのはページと Claude の `ArtifactData` のツールだけ）。
 * そこで CLI は手元の写しを読み、書き込みは送る箱に積む。DB との行き来は Claude が `board-store` のスキルの手順で行う。
 *
 * ```
 * <storeDir>/mirror/<collection>/<論理 ID>~<6 桁の連番>.json   写し（`ArtifactData` の out_dir が書く形。中身だけ）
 * <storeDir>/outbox/<連番>.json                                 送る箱の束（どの文書をどのファイルから作るか）
 * <storeDir>/outbox/docs/<連番>-<n>.json                        束が指す文書の中身
 * <storeDir>/store.lock                                         手元の複数のプロセスを 1 列にするロック
 * ```
 *
 * **置き場所の文書は書き換えない。** 論理 ID の文書を変えるたびに、連番を 1 つ進めた新しい文書（改訂）を作る。
 * 読むときは論理 ID ごとに連番の最も大きい改訂を使い、消したことは `{ "__deleted": true }` の改訂で表す。
 * `out_dir` の書き出しには版（`version`）が入らないので、`if_version` を使わずに済むようにした。
 * 既にある ID を版なしで作ろうとした `batch` は DB が丸ごと拒むので、2 つの端末が同じ改訂を作ると片方が拒まれる（楽観ロック）。
 * 拒まれたら `discard` で送る箱を捨て、取り込み直して元のコマンドを頭からやり直す。
 */
export class ArtifactMirrorStore implements DocumentStore {
  readonly mirrorDir: string;
  readonly outboxDir: string;
  private readonly lockPath: string;
  private index: MirrorIndex | null = null;
  /** `transact` の中で作った改訂（論理 ID ごとの物理 ID）。null なら transact の外 */
  private written: Map<string, WrittenRevision> | null = null;

  constructor(
    readonly storeDir: string,
    private readonly lockOptions: LockOptions = defaultLockOptions
  ) {
    this.mirrorDir = path.join(storeDir, MIRROR_DIR);
    this.outboxDir = path.join(storeDir, OUTBOX_DIR);
    this.lockPath = path.join(storeDir, LOCK_FILE);
  }

  check(): Result<void, StoreError> {
    if (!fs.existsSync(this.mirrorDir)) {
      return err({ type: 'StoreNotPulled', mirrorDir: this.mirrorDir });
    }
    return checkMeta(this);
  }

  get(collection: Collection, id: string): DocumentData | null {
    const entry = this.loadIndex().get(collection)?.get(id);
    if (entry === undefined || isDeleted(entry.data)) return null;
    return entry.data;
  }

  list(collection: Collection): readonly StoredDocument[] {
    const table = this.loadIndex().get(collection);
    if (table === undefined) return [];
    return [...table.entries()]
      .filter(([, entry]) => !isDeleted(entry.data))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([id, entry]) => ({ id, data: entry.data }));
  }

  set(collection: Collection, id: string, data: DocumentData): void {
    assertWritable(collection, id);
    if (isDeleted(data)) throw new Error('__deleted は文書の中身に使えません');
    this.writeRevision(collection, id, data);
  }

  delete(collection: Collection, id: string): void {
    assertWritable(collection, id);
    if (this.written === null) throw new Error('書き込みは transact の中でだけ行えます');
    if (this.get(collection, id) === null) return;
    this.writeRevision(collection, id, DELETED);
  }

  pendingWrites(): number {
    return this.readBatches().length;
  }

  /** 写しが無い・形の版が違うときは、`op` を走らせずに Err を返す（古い CLI や取り込み忘れで書かない） */
  async transact<T, E>(
    label: TransactLabel<T>,
    op: () => Promise<Result<T, E>>
  ): Promise<Result<T, E | StoreError>> {
    const checked = this.check();
    if (isErr(checked)) return checked;
    return this.transactUnchecked(label, op);
  }

  /**
   * 写しを確かめずに書く。空の置き場所を始める `ai-board store init` だけが使う
   * （`board/meta` を書く前なので `check` が通らない）
   */
  async transactUnchecked<T, E>(
    label: TransactLabel<T>,
    op: () => Promise<Result<T, E>>
  ): Promise<Result<T, E | StoreError>> {
    const locked = await withFileLock(this.lockPath, this.lockOptions, async () => {
      // ほかのプロセスが書いたかもしれないので、写しを読み直してから始める
      this.index = null;
      this.written = new Map();
      let succeeded = false;
      try {
        const result = await op();
        if (result.ok) {
          this.enqueue(labelOf(label, result.value), [...this.written.values()]);
          succeeded = true;
        }
        return result;
      } finally {
        if (!succeeded) this.rollback([...this.written.values()]);
        this.written = null;
      }
    });
    if (isErr(locked)) return err({ type: 'StoreLockTimeout', lockPath: locked.error.lockPath });
    return locked.value;
  }

  /**
   * `ArtifactData` の `list` が `out_dir` に書き出したディレクトリから、写しを丸ごと入れ替える。
   *
   * 送る箱が空でなければ拒む（まだ送っていない書き込みの土台が変わるため）。
   * 規定のコレクションの `*.json` だけを読み、どれか 1 つでも読めなければ何も変えない。
   */
  async pull(fromDir: string): Promise<Result<{ readonly count: number }, StoreError>> {
    const locked = await withFileLock(
      this.lockPath,
      this.lockOptions,
      (): Promise<Result<{ readonly count: number }, StoreError>> => {
        const pending = this.readBatches().length;
        if (pending > 0)
          return Promise.resolve(err<StoreError>({ type: 'StorePendingWrites', count: pending }));

        const incoming = readExport(fromDir);
        if (isErr(incoming)) return Promise.resolve(incoming);

        const tmp = `${this.mirrorDir}.tmp-${process.pid}`;
        fs.rmSync(tmp, { recursive: true, force: true });
        for (const doc of incoming.value) {
          const dir = path.join(tmp, doc.collection);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${doc.physicalId}.json`), serialize(doc.data));
        }
        fs.mkdirSync(tmp, { recursive: true });
        fs.rmSync(this.mirrorDir, { recursive: true, force: true });
        fs.renameSync(tmp, this.mirrorDir);
        this.index = null;
        return Promise.resolve(ok({ count: incoming.value.length }));
      }
    );
    if (isErr(locked)) return err({ type: 'StoreLockTimeout', lockPath: locked.error.lockPath });
    return locked.value;
  }

  /**
   * 送る箱の書き込みを、`ArtifactData` の `batch` の `writes` にそのまま渡せる形で返す。
   * 1 つの束が 50 件を超えるときは 50 件ずつに分ける（`batch` の上限）
   */
  outbox(): readonly OutboxBatch[] {
    const batches: OutboxBatch[] = [];
    for (const batch of this.readBatches()) {
      for (let i = 0; i < batch.writes.length; i += BATCH_LIMIT) {
        batches.push({
          label: batch.label,
          writes: batch.writes.slice(i, i + BATCH_LIMIT).map((write) => ({
            op: 'set',
            collection: write.collection,
            doc_id: write.physicalId,
            file_path: path.join(this.outboxDir, DOCS_DIR, write.file),
          })),
        });
      }
    }
    return batches;
  }

  /** 送り終えた送る箱を空にする。写しはそのまま（続けて取り込み直す） */
  ack(): number {
    const count = this.readBatches().length;
    fs.rmSync(this.outboxDir, { recursive: true, force: true });
    return count;
  }

  /** 送る箱を捨て、写しに足した改訂を消して、積む前に戻す（改訂がぶつかったとき） */
  async discard(): Promise<Result<number, StoreError>> {
    const locked = await withFileLock(this.lockPath, this.lockOptions, () => {
      const batches = this.readBatches();
      for (const batch of batches) {
        for (const write of batch.writes) {
          fs.rmSync(path.join(this.mirrorDir, write.collection, `${write.physicalId}.json`), {
            force: true,
          });
        }
      }
      fs.rmSync(this.outboxDir, { recursive: true, force: true });
      this.index = null;
      return Promise.resolve(batches.length);
    });
    if (isErr(locked)) return err({ type: 'StoreLockTimeout', lockPath: locked.error.lockPath });
    return ok(locked.value);
  }

  // ------------------------------------------------------------

  private writeRevision(collection: Collection, id: string, data: DocumentData): void {
    if (this.written === null) throw new Error('書き込みは transact の中でだけ行えます');
    const key = `${collection}/${id}`;
    const table = this.table(collection);
    let revision = this.written.get(key);
    if (revision === undefined) {
      const next = (table.get(id)?.rev ?? 0) + 1;
      revision = { collection, id, physicalId: physicalId(id, next), rev: next };
      this.written.set(key, revision);
    }
    const dir = path.join(this.mirrorDir, collection);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${revision.physicalId}.json`), serialize(data));
    table.set(id, { rev: revision.rev, data: structuredClone(data) });
  }

  private rollback(revisions: readonly WrittenRevision[]): void {
    for (const revision of revisions) {
      fs.rmSync(path.join(this.mirrorDir, revision.collection, `${revision.physicalId}.json`), {
        force: true,
      });
    }
    this.index = null;
  }

  private enqueue(label: string, revisions: readonly WrittenRevision[]): void {
    if (revisions.length === 0) return;
    const docsDir = path.join(this.outboxDir, DOCS_DIR);
    fs.mkdirSync(docsDir, { recursive: true });
    const seq = this.nextBatchSeq();
    const writes = revisions.map((revision, n) => {
      const file = `${seq}-${n + 1}.json`;
      fs.copyFileSync(
        path.join(this.mirrorDir, revision.collection, `${revision.physicalId}.json`),
        path.join(docsDir, file)
      );
      return { collection: revision.collection, physicalId: revision.physicalId, file };
    });
    const batch: StoredBatch = { label, writes };
    fs.writeFileSync(path.join(this.outboxDir, `${seq}.json`), serialize(batch));
  }

  private nextBatchSeq(): string {
    const last = this.batchFiles().at(-1);
    const next = last === undefined ? 1 : Number.parseInt(last, 10) + 1;
    return String(next).padStart(6, '0');
  }

  private batchFiles(): string[] {
    if (!fs.existsSync(this.outboxDir)) return [];
    return fs
      .readdirSync(this.outboxDir)
      .filter((name) => /^\d{6}\.json$/.test(name))
      .sort();
  }

  private readBatches(): StoredBatch[] {
    return this.batchFiles().map(
      (name) => JSON.parse(fs.readFileSync(path.join(this.outboxDir, name), 'utf-8')) as StoredBatch
    );
  }

  private table(collection: Collection): Map<string, IndexEntry> {
    const index = this.loadIndex();
    let table = index.get(collection);
    if (table === undefined) {
      table = new Map();
      index.set(collection, table);
    }
    return table;
  }

  private loadIndex(): MirrorIndex {
    if (this.index !== null) return this.index;
    const index: MirrorIndex = new Map();
    for (const collection of COLLECTIONS) {
      const dir = path.join(this.mirrorDir, collection);
      if (!fs.existsSync(dir)) continue;
      const table = new Map<string, IndexEntry>();
      for (const name of fs.readdirSync(dir)) {
        const parsed = parsePhysicalFile(name);
        if (parsed === null) continue;
        const current = table.get(parsed.id);
        if (current !== undefined && current.rev >= parsed.rev) continue;
        const data = readJsonObject(path.join(dir, name));
        if (data === null) continue;
        table.set(parsed.id, { rev: parsed.rev, data });
      }
      index.set(collection, table);
    }
    this.index = index;
    return index;
  }
}

/** `outbox --json` の 1 つの束。`writes` は `ArtifactData` の `batch` の `writes` にそのまま渡せる */
export interface OutboxBatch {
  readonly label: string;
  readonly writes: readonly {
    readonly op: 'set';
    readonly collection: Collection;
    readonly doc_id: string;
    readonly file_path: string;
  }[];
}

export const MIRROR_DIR = 'mirror';
export const OUTBOX_DIR = 'outbox';
export const DOCS_DIR = 'docs';
export const LOCK_FILE = 'store.lock';
/** `ArtifactData` の `batch` の 1 回の上限 */
export const BATCH_LIMIT = 50;

const REVISION_SEPARATOR = '~';
const DELETED: DocumentData = { __deleted: true };

interface IndexEntry {
  readonly rev: number;
  readonly data: DocumentData;
}
type MirrorIndex = Map<Collection, Map<string, IndexEntry>>;

interface WrittenRevision {
  readonly collection: Collection;
  readonly id: string;
  readonly physicalId: string;
  readonly rev: number;
}

interface StoredBatch {
  readonly label: string;
  readonly writes: readonly {
    readonly collection: Collection;
    readonly physicalId: string;
    readonly file: string;
  }[];
}

function isDeleted(data: DocumentData): boolean {
  return data.__deleted === true;
}

/** 論理 ID と連番から、置き場所の文書の ID を作る */
export function physicalId(id: string, rev: number): string {
  return `${id}${REVISION_SEPARATOR}${String(rev).padStart(6, '0')}`;
}

/** `<論理 ID>~<連番>.json` を読み分ける。形が違えば null */
export function parsePhysicalFile(name: string): { id: string; rev: number } | null {
  if (!name.endsWith('.json')) return null;
  const stem = name.slice(0, -'.json'.length);
  const at = stem.lastIndexOf(REVISION_SEPARATOR);
  if (at <= 0) return null;
  const id = stem.slice(0, at);
  const revText = stem.slice(at + 1);
  if (!/^\d{6,}$/.test(revText) || !isValidDocumentId(id)) return null;
  const rev = Number.parseInt(revText, 10);
  if (rev < 1) return null;
  return { id, rev };
}

function serialize(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJsonObject(file: string): DocumentData | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is DocumentData {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `out_dir` の書き出しを読む。規定のコレクションの `*.json` だけで、どれか 1 つでも読めなければ Err */
function readExport(
  fromDir: string
): Result<{ collection: Collection; physicalId: string; data: DocumentData }[], StoreError> {
  if (!fs.existsSync(fromDir) || !fs.statSync(fromDir).isDirectory()) {
    return err({ type: 'StoreInvalidDocument', path: fromDir, reason: 'ディレクトリがありません' });
  }
  const docs: { collection: Collection; physicalId: string; data: DocumentData }[] = [];
  for (const collection of COLLECTIONS) {
    const dir = path.join(fromDir, collection);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      if (!name.endsWith('.json')) continue;
      const parsed = parsePhysicalFile(name);
      if (parsed === null) {
        return err({
          type: 'StoreInvalidDocument',
          path: file,
          reason: '文書の ID の形が違います',
        });
      }
      const data = readJsonObject(file);
      if (data === null) {
        return err({
          type: 'StoreInvalidDocument',
          path: file,
          reason: 'JSON のオブジェクトとして読めません',
        });
      }
      docs.push({ collection, physicalId: name.slice(0, -'.json'.length), data });
    }
  }
  return ok(docs);
}
