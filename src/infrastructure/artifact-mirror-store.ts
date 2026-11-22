import * as fs from 'node:fs';
import * as path from 'node:path';
import { err, isErr, ok, type Result } from '../shared/result.js';
import { compareStrings } from '../shared/compare.js';
import {
  assertWritable,
  checkMeta,
  COLLECTIONS,
  initialDocuments,
  META_COLLECTION,
  META_ID,
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
export class ArtifactMirrorStore implements DocumentStore, MirrorSync {
  readonly mirrorDir: string;
  readonly outboxDir: string;
  private readonly lockPath: string;
  private index: MirrorIndex | null = null;
  /** 写しの中の、最新なのに読めない改訂のファイル（`loadIndex` が埋める） */
  private corrupt: string[] = [];
  /** `transact` の中で作った改訂（論理 ID ごと）。null なら transact の外 */
  private written: Map<string, WrittenRevision> | null = null;

  constructor(
    readonly storeDir: string,
    private readonly lockOptions: LockOptions = defaultLockOptions
  ) {
    this.mirrorDir = path.join(storeDir, MIRROR_DIR);
    this.outboxDir = path.join(storeDir, OUTBOX_DIR);
    this.lockPath = path.join(storeDir, LOCK_FILE);
  }

  /**
   * 写しがあり、形の版が合い、どの文書の最新の改訂も読めるか。
   * 読めない改訂（書きかけで壊れたなど）があれば、取り込み直すまで読み書きしない
   * （古い改訂を読んで書くと、送るときに原因の分からないぶつかりになるため）
   */
  check(): Promise<Result<void, StoreError>> {
    return Promise.resolve(this.checkSync());
  }

  private checkSync(): Result<void, StoreError> {
    if (!fs.existsSync(this.mirrorDir)) {
      return err({ type: 'StoreNotPulled', mirrorDir: this.mirrorDir });
    }
    this.loadIndex();
    const corrupt = this.corrupt[0];
    if (corrupt !== undefined) {
      return err({
        type: 'StoreInvalidDocument',
        path: corrupt,
        reason: '写しの改訂が JSON のオブジェクトとして読めません。取り込み直してください',
      });
    }
    return checkMeta(this);
  }

  get(collection: Collection, id: string): DocumentData | null {
    const entry = this.loadIndex().get(collection)?.get(id);
    return entry === undefined || isAbsent(entry.data) ? null : entry.data;
  }

  list(collection: Collection): readonly StoredDocument[] {
    const table = this.loadIndex().get(collection);
    if (table === undefined) return [];
    return [...table.entries()]
      .flatMap(([id, entry]) => (isAbsent(entry.data) ? [] : [{ id, data: entry.data }]))
      .sort((a, b) => compareStrings(a.id, b.id));
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
    return this.batchSeqs().length;
  }

  /** 写しが無い・形の版が違う・読めない改訂があるときは、`op` を走らせずに Err を返す */
  async transact<T, E>(
    label: TransactLabel<T>,
    op: () => Promise<Result<T, E>>
  ): Promise<Result<T, E | StoreError>> {
    const checked = this.checkSync();
    if (isErr(checked)) return checked;
    const locked = await this.locked(async () => {
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
        if (!succeeded) this.removeRevisions([...this.written.values()]);
        this.written = null;
      }
    });
    return isErr(locked) ? locked : locked.value;
  }

  /**
   * 空の置き場所を始める（`ai-board store init`）。`board/meta` が無いときだけ最初の文書を送る箱に積み、積んだら true。
   * `board/meta` を書く前は `check` が通らないので、`transact` を通さずにここで書く
   */
  async initialize(): Promise<Result<boolean, StoreError>> {
    return this.locked(() => {
      this.index = null;
      if (this.get(META_COLLECTION, META_ID) !== null) return false;
      this.written = new Map();
      try {
        for (const doc of initialDocuments()) this.writeRevision(doc.collection, doc.id, doc.data);
        this.enqueue('置き場所を始める', [...this.written.values()]);
      } finally {
        this.written = null;
      }
      return true;
    });
  }

  /**
   * `ArtifactData` の `list` が `out_dir` に書き出したディレクトリから、写しを丸ごと入れ替える。
   *
   * 送る箱が空でなければ拒む（まだ送っていない書き込みの土台が変わるため）。
   * 規定のコレクションの `*.json` だけを読み、どれか 1 つでも読めなければ何も変えない。
   */
  async pull(fromDir: string): Promise<Result<{ readonly count: number }, StoreError>> {
    const locked = await this.locked((): Result<{ readonly count: number }, StoreError> => {
      const pending = this.pendingWrites();
      if (pending > 0) return err({ type: 'StorePendingWrites', count: pending });

      const incoming = readExport(fromDir);
      if (isErr(incoming)) return incoming;

      const tmp = `${this.mirrorDir}.tmp-${process.pid}`;
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      for (const doc of incoming.value) {
        const dir = path.join(tmp, doc.collection);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `${doc.physicalId}.json`), serialize(doc.data));
      }
      fs.rmSync(this.mirrorDir, { recursive: true, force: true });
      fs.renameSync(tmp, this.mirrorDir);
      this.index = null;
      return ok({ count: incoming.value.length });
    });
    return isErr(locked) ? locked : locked.value;
  }

  /**
   * 送る箱の書き込みを、`ArtifactData` の `batch` の `writes` にそのまま渡せる形で返す。
   * 1 つの束が 50 件を超えるときは 50 件ずつに分ける（`batch` の上限）
   */
  outbox(): readonly OutboxBatch[] {
    const batches: OutboxBatch[] = [];
    for (const [seq, batch] of this.readBatches()) {
      for (let i = 0; i < batch.writes.length; i += BATCH_LIMIT) {
        batches.push({
          seq,
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

  /**
   * 送り終えた束を送る箱から消す。消すのは連番が `through` 以下の束だけで、`outbox` を読んだ後に
   * ほかのプロセスが積んだ束は残す。写しはそのまま
   */
  async ack(through: string): Promise<Result<number, StoreError>> {
    return this.locked(() => {
      const sent = this.readBatches().filter(([seq]) => seq <= through);
      for (const [seq, batch] of sent) {
        for (const write of batch.writes) {
          fs.rmSync(path.join(this.outboxDir, DOCS_DIR, write.file), { force: true });
        }
        fs.rmSync(this.batchPath(seq), { force: true });
      }
      return sent.length;
    });
  }

  /** 送る箱を捨て、写しに足した改訂を消して、積む前に戻す（改訂がぶつかったとき） */
  async discard(): Promise<Result<number, StoreError>> {
    return this.locked(() => {
      const batches = this.readBatches();
      this.removeRevisions(batches.flatMap(([, batch]) => batch.writes));
      fs.rmSync(this.outboxDir, { recursive: true, force: true });
      return batches.length;
    });
  }

  // ------------------------------------------------------------

  /** ロックを取って `op` を走らせる。待ち切れなければ `StoreLockTimeout` */
  private async locked<T>(op: () => T | Promise<T>): Promise<Result<T, StoreError>> {
    const result = await withFileLock(this.lockPath, this.lockOptions, async () => op());
    return isErr(result)
      ? err({ type: 'StoreLockTimeout', lockPath: result.error.lockPath })
      : result;
  }

  private revisionPath(collection: Collection, physical: string): string {
    return path.join(this.mirrorDir, collection, `${physical}.json`);
  }

  private batchPath(seq: string): string {
    return path.join(this.outboxDir, `${seq}.json`);
  }

  private writeRevision(collection: Collection, id: string, data: DocumentData): void {
    if (this.written === null) throw new Error('書き込みは transact の中でだけ行えます');
    const key = `${collection}/${id}`;
    const table = this.table(collection);
    let revision = this.written.get(key);
    if (revision === undefined) {
      // 読めない改訂も連番に数える（同じ名前のファイルを上書きしない）
      revision = { collection, physicalId: physicalId(id, (table.get(id)?.rev ?? 0) + 1) };
      this.written.set(key, revision);
    }
    const file = this.revisionPath(collection, revision.physicalId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, serialize(data));
    table.set(id, {
      rev: parsePhysicalId(revision.physicalId)?.rev ?? 0,
      data: structuredClone(data),
    });
  }

  /** 写しから改訂のファイルを消し、読み直させる（拒まれた transact と discard） */
  private removeRevisions(
    revisions: readonly { readonly collection: Collection; readonly physicalId: string }[]
  ): void {
    for (const revision of revisions) {
      fs.rmSync(this.revisionPath(revision.collection, revision.physicalId), { force: true });
    }
    this.index = null;
  }

  private enqueue(label: string, revisions: readonly WrittenRevision[]): void {
    if (revisions.length === 0) return;
    const docsDir = path.join(this.outboxDir, DOCS_DIR);
    fs.mkdirSync(docsDir, { recursive: true });
    const last = this.batchSeqs().at(-1);
    const seq = formatSeq(last === undefined ? 1 : Number.parseInt(last, 10) + 1);
    const writes = revisions.map((revision, n) => {
      const file = `${seq}-${n + 1}.json`;
      fs.copyFileSync(
        this.revisionPath(revision.collection, revision.physicalId),
        path.join(docsDir, file)
      );
      return { collection: revision.collection, physicalId: revision.physicalId, file };
    });
    const batch: StoredBatch = { label, writes };
    fs.writeFileSync(this.batchPath(seq), serialize(batch));
  }

  /** 送る箱の束の連番。昇順 */
  private batchSeqs(): string[] {
    if (!fs.existsSync(this.outboxDir)) return [];
    return fs
      .readdirSync(this.outboxDir)
      .filter((name) => BATCH_FILE.test(name))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
  }

  private readBatches(): [string, StoredBatch][] {
    return this.batchSeqs().map((seq) => [
      seq,
      JSON.parse(fs.readFileSync(this.batchPath(seq), 'utf-8')) as StoredBatch,
    ]);
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

  /**
   * 写しを読み、論理 ID ごとに最新の改訂を選ぶ。先にファイル名で最新を選び、中身はその改訂だけを読む。
   * 最新が読めなければその文書は無いものとして読み、`corrupt` に控えて `check` が取り込み直しを促す
   */
  private loadIndex(): MirrorIndex {
    if (this.index !== null) return this.index;
    const index: MirrorIndex = new Map();
    const corrupt: string[] = [];
    for (const collection of COLLECTIONS) {
      const dir = path.join(this.mirrorDir, collection);
      if (!fs.existsSync(dir)) continue;
      const latest = new Map<string, number>();
      for (const name of fs.readdirSync(dir)) {
        const parsed = parsePhysicalFile(name);
        if (parsed !== null && parsed.rev > (latest.get(parsed.id) ?? 0)) {
          latest.set(parsed.id, parsed.rev);
        }
      }
      const table = new Map<string, IndexEntry>();
      for (const [id, rev] of latest) {
        const file = this.revisionPath(collection, physicalId(id, rev));
        const data = readJsonObject(file);
        if (data === null) corrupt.push(file);
        table.set(id, { rev, data });
      }
      index.set(collection, table);
    }
    this.index = index;
    this.corrupt = corrupt;
    return index;
  }
}

/**
 * 写しと置き場所（Artifact の DB）の行き来の口。`ai-board store` が使う。
 * `DocumentStore` の外に置き、SQLite に切り替えたら口ごと外す
 */
export interface MirrorSync {
  pull(fromDir: string): Promise<Result<{ readonly count: number }, StoreError>>;
  outbox(): readonly OutboxBatch[];
  ack(through: string): Promise<Result<number, StoreError>>;
  discard(): Promise<Result<number, StoreError>>;
  initialize(): Promise<Result<boolean, StoreError>>;
}

/** 束の連番の形（6 桁）。`ack --through` の検査にも使う */
export const SEQ_PATTERN = /^\d{6}$/;
const BATCH_FILE = /^\d{6}\.json$/;

function formatSeq(n: number): string {
  return String(n).padStart(6, '0');
}

/** `outbox --json` の 1 つの束。`writes` は `ArtifactData` の `batch` の `writes` にそのまま渡せる */
export interface OutboxBatch {
  /** 束の連番。送り終えたら `ack --through <連番>` に渡す（50 件で分けた束は同じ連番を持つ） */
  readonly seq: string;
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
/** `ArtifactData` の `out_dir` がファイル名で `~` の代わりに使う文字 */
const EXPORT_REVISION_SEPARATOR = '@';
const DELETED: DocumentData = { __deleted: true };

interface IndexEntry {
  readonly rev: number;
  /** 最新の改訂が読めなければ null */
  readonly data: DocumentData | null;
}
type MirrorIndex = Map<Collection, Map<string, IndexEntry>>;

interface WrittenRevision {
  readonly collection: Collection;
  readonly physicalId: string;
}

/** 束の中身。`scripts/artifact-data-guard.mjs` も同じ形で読む（変えたら hook も直す） */
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

/** 読めない（null）か、消したことを表す改訂 */
function isAbsent(data: DocumentData | null): data is null {
  return data === null || isDeleted(data);
}

/** 論理 ID と連番から、置き場所の文書の ID を作る */
export function physicalId(id: string, rev: number): string {
  return `${id}${REVISION_SEPARATOR}${formatSeq(rev)}`;
}

/** `<論理 ID>~<連番>.json` を読み分ける。形が違えば null */
export function parsePhysicalFile(name: string): { id: string; rev: number } | null {
  return name.endsWith('.json') ? parsePhysicalId(name.slice(0, -'.json'.length)) : null;
}

/**
 * `ArtifactData` の `out_dir` が書いた 1 ファイルの名前を読み分ける。形が違えば null。
 *
 * `out_dir` はファイル名の `~` を `@` に置き換えて書く（`meta~000001` → `meta@000001.json`）。
 * 名前に `~` があればそのまま読み（手で作った書き出し）、無ければ最後の `@` を改訂の区切りとして読む。
 * 論理 ID には `@` を使えるが、改訂の連番は数字だけで必ず末尾にあるので、最後の `@` で分ければ取り違えない。
 * 写しの中のファイルは CLI が `~` で書くので、`parsePhysicalFile` で厳しく読む
 */
export function parseExportFile(name: string): { id: string; rev: number } | null {
  if (!name.endsWith('.json')) return null;
  const stem = name.slice(0, -'.json'.length);
  if (stem.includes(REVISION_SEPARATOR)) return parsePhysicalId(stem);
  const at = stem.lastIndexOf(EXPORT_REVISION_SEPARATOR);
  return at <= 0
    ? null
    : parsePhysicalId(`${stem.slice(0, at)}${REVISION_SEPARATOR}${stem.slice(at + 1)}`);
}

/** `<論理 ID>~<連番>` を読み分ける。形が違えば null */
function parsePhysicalId(stem: string): { id: string; rev: number } | null {
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

/**
 * `out_dir` の書き出しを読む。規定のコレクションの `*.json` だけで、どれか 1 つでも読めなければ Err。
 * ファイル名は `~` と `@` のどちらの区切りでも読む（`parseExportFile`）
 */
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
      const parsed = parseExportFile(name);
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
      // 写しには `~` の名前で入れる（書き出しの `@` の名前を持ち込まない）
      docs.push({ collection, physicalId: physicalId(parsed.id, parsed.rev), data });
    }
  }
  return ok(docs);
}
