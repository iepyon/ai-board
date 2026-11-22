import { compareStrings } from '../shared/compare.js';
import { err, ok, type Result } from '../shared/result.js';

// ============================================================
// 置き場所の口 — カードの正本を文書（コレクションと ID で指す JSON）として読み書きする
// ============================================================

/**
 * カード・判断・並び順・PR の控え・ループの記録は、この口だけを通して読み書きする。
 *
 * 実装は置き場所ごとに 1 つ置く。
 *
 * - `GitDocumentStore`（`git-document-store.ts`）: git の置き場所のブランチの `.ai-board/` のファイル。
 *   fetch して読み、書き込みはコミットとして push する
 * - `MemoryDocumentStore`（このファイル）: メモリ。テストで使う
 * - SQLite に切り替えるときは、書き込み系を含む実装を新たに足す。口とその上（リポジトリ・usecase・CLI）は変えない
 *
 * どの実装も次の約束を守る（`__tests__/document-store.contract.ts` で確かめる）。
 *
 * - 読み出し（`get` / `list`）は、`transact` の中ではその中で書いたものを含む最新を返す
 * - 書き込み（`set` / `delete`）は `transact` の中でだけ行える。外で呼ぶと例外を投げる（呼び出し側の誤り）
 * - `transact` の `op` が Err を返すか例外を投げたら、その中の書き込みは無かったことになる（全部か無し）
 * - 失敗は `StoreError` で返す
 * - `pendingWrites()` は、置き場所にまだ届いていない書き込みの束の数を返す（その場で届く実装は常に 0）
 */
export interface DocumentStore extends DocumentReader {
  /**
   * 読み書きできる状態か（置き場所を読める、形の版が合う、など）。CLI は読む前に必ず 1 回 `await` する。
   * 置き場所を手元へ読み込む実装（git の fetch など）は、ここで読み込む
   */
  check(): Promise<Result<void, StoreError>>;

  /**
   * 書き込みの 1 操作。ロックを取り、`op` を走らせ、Ok なら書き込みを確定する。
   * `op` は標準出力にも標準エラーにも書かない。拒むときは Err を返す
   */
  transact<T, E>(
    label: TransactLabel<T>,
    op: () => Promise<Result<T, E>>
  ): Promise<Result<T, E | StoreError>>;

  /** 文書を 1 つ書く（置き換え）。`transact` の中でだけ呼ぶ */
  set(collection: Collection, id: string, data: DocumentData): void;

  /** 文書を 1 つ消す。無ければ何もしない。`transact` の中でだけ呼ぶ */
  delete(collection: Collection, id: string): void;

  /** 置き場所にまだ届いていない書き込みの束の数 */
  pendingWrites(): number;
}

/** 書き込みの 1 操作の名前（git の置き場所ではコミットの題）。結果から決めるときは関数で渡す。ID・ゲート・種別だけを入れ、ブランチ名や理由は入れない */
export type TransactLabel<T> = string | ((value: T) => string);

export function labelOf<T>(label: TransactLabel<T>, value: T): string {
  return typeof label === 'string' ? label : label(value);
}

/** 読み出しだけの口 */
export interface DocumentReader {
  get(collection: Collection, id: string): DocumentData | null;
  /** ID の昇順で返す */
  list(collection: Collection): readonly StoredDocument[];
}

/** 文書の中身。JSON のオブジェクト */
export type DocumentData = Readonly<Record<string, unknown>>;

export interface StoredDocument {
  readonly id: string;
  readonly data: DocumentData;
}

/** 置き場所のコレクション。ここに無いものは読み書きしない */
export const COLLECTIONS = ['board', 'order', 'cards', 'log', 'snapshots', 'loop'] as const;
export type Collection = (typeof COLLECTIONS)[number];

export function isCollection(value: string): value is Collection {
  return (COLLECTIONS as readonly string[]).includes(value);
}

/** 置き場所の形の版。`board/meta` の `version` に持つ */
export const STORE_VERSION = 3;
export const META_COLLECTION: Collection = 'board';
export const META_ID = 'meta';

/**
 * 文書の ID に使える文字。git の置き場所ではファイル名にもなるので、パスの区切りや空白を含めない。
 * `.` と `..` だけの ID は使えない
 */
const DOCUMENT_ID_PATTERN = /^(?!\.\.?$)[A-Za-z0-9_\-.:@+]{1,180}$/;

export function isValidDocumentId(id: string): boolean {
  return DOCUMENT_ID_PATTERN.test(id);
}

export type StoreError =
  /** 置き場所に `board/meta` が無い（`ai-board store init` を走らせていない） */
  | { readonly type: 'StoreUninitialized' }
  /** 置き場所の形の版が、この CLI と違う */
  | { readonly type: 'StoreVersionMismatch'; readonly found: unknown; readonly expected: number }
  /** ほかのプロセスが書いている */
  | { readonly type: 'StoreLockTimeout'; readonly lockPath: string }
  /** 置き場所のリモートがリポジトリに無い（git の置き場所） */
  | { readonly type: 'StoreRemoteMissing'; readonly remote: string }
  /** git の操作が失敗した（git の置き場所。届かない・権限が無い など） */
  | { readonly type: 'StoreGitFailed'; readonly operation: string; readonly message: string }
  /** push が先を越され続けた（git の置き場所） */
  | { readonly type: 'StorePushConflict'; readonly attempts: number }
  /** 置き場所は既に始まっている（`ai-board store init` を 2 度走らせた） */
  | { readonly type: 'StoreAlreadyInitialized' };

/** `board/meta` を確かめる。無い・版が違うときは Err */
export function checkMeta(reader: DocumentReader): Result<void, StoreError> {
  const meta = reader.get(META_COLLECTION, META_ID);
  if (meta === null) return err({ type: 'StoreUninitialized' });
  if (meta.version !== STORE_VERSION) {
    return err({ type: 'StoreVersionMismatch', found: meta.version, expected: STORE_VERSION });
  }
  return ok(undefined);
}

/** 空の置き場所に書く最初の文書（`ai-board store init`） */
export function initialDocuments(): readonly {
  collection: Collection;
  id: string;
  data: DocumentData;
}[] {
  return [{ collection: META_COLLECTION, id: META_ID, data: { version: STORE_VERSION } }];
}

/** 書き込みの検査。ID が使えない・コレクションが規定外なら例外（呼び出し側の誤り） */
export function assertWritable(collection: string, id: string): void {
  if (!isCollection(collection)) throw new Error(`規定外のコレクションです: ${collection}`);
  if (!isValidDocumentId(id)) throw new Error(`文書の ID に使えない文字があります: ${id}`);
}

/** 文書の並びを読み出しだけの口にする（`copyDocuments` の写し元） */
export function readerOf(
  docs: readonly { collection: Collection; id: string; data: DocumentData }[]
): DocumentReader {
  return {
    get: (collection, id) =>
      docs.find((doc) => doc.collection === collection && doc.id === id)?.data ?? null,
    list: (collection) =>
      docs
        .filter((doc) => doc.collection === collection)
        .map(({ id, data }) => ({ id, data }))
        .sort((a, b) => compareStrings(a.id, b.id)),
  };
}

/** `copyDocuments` の指定 */
export interface CopyOptions<E> {
  /** 写すコレクション。既定は全部 */
  readonly collections?: readonly Collection[];
  /** 写し先の今の中身を見て、写さずに止める理由を返す（`transact` の中で、写し先を読み直した後に呼ぶ）。写すなら null */
  readonly refuse?: (to: DocumentReader) => E | null;
}

/**
 * 置き場所の間で文書を写す（`ai-board store import`、将来 SQLite へ移すとき）。
 *
 * `from` の文書を、`to` の 1 回の `transact` で書く。`to` に既にある ID は上書きする。
 * `refuse` が理由を返したら何も書かない（例: 写し先にカードがあれば二重に移さない）。
 */
export async function copyDocuments<E = never>(
  from: DocumentReader,
  to: DocumentStore,
  label: string,
  options: CopyOptions<E> = {}
): Promise<Result<number, E | StoreError>> {
  const collections = options.collections ?? COLLECTIONS;
  return to.transact<number, E>(label, () => {
    const refused = options.refuse?.(to) ?? null;
    if (refused !== null) return Promise.resolve(err(refused));
    let count = 0;
    for (const collection of collections) {
      for (const doc of from.list(collection)) {
        to.set(collection, doc.id, doc.data);
        count += 1;
      }
    }
    return Promise.resolve(ok(count));
  });
}

// ============================================================
// メモリの実装（テスト用）
// ============================================================

/** メモリに文書を持つ。書き込みはその場で確定し、届くまでの段は無い */
export class MemoryDocumentStore implements DocumentStore {
  private readonly docs = new Map<Collection, Map<string, DocumentData>>();
  private working: Map<Collection, Map<string, DocumentData>> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(initial: readonly { collection: Collection; id: string; data: DocumentData }[] = []) {
    for (const doc of initial) this.table(this.docs, doc.collection).set(doc.id, doc.data);
  }

  check(): Promise<Result<void, StoreError>> {
    return Promise.resolve(checkMeta(this));
  }

  get(collection: Collection, id: string): DocumentData | null {
    return this.table(this.current(), collection).get(id) ?? null;
  }

  list(collection: Collection): readonly StoredDocument[] {
    return [...this.table(this.current(), collection).entries()]
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([id, data]) => ({ id, data }));
  }

  set(collection: Collection, id: string, data: DocumentData): void {
    assertWritable(collection, id);
    this.table(this.requireWorking(), collection).set(id, structuredClone(data));
  }

  delete(collection: Collection, id: string): void {
    assertWritable(collection, id);
    this.table(this.requireWorking(), collection).delete(id);
  }

  pendingWrites(): number {
    return 0;
  }

  transact<T, E>(
    _label: TransactLabel<T>,
    op: () => Promise<Result<T, E>>
  ): Promise<Result<T, E | StoreError>> {
    // 同じプロセスの中の transact を 1 列にする（ファイルのロックと同じ振る舞い）
    const run = this.queue.then(async () => {
      this.working = cloneTables(this.docs);
      try {
        const result = await op();
        if (result.ok) {
          this.docs.clear();
          for (const [collection, table] of this.working) this.docs.set(collection, table);
        }
        return result;
      } finally {
        this.working = null;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private current(): Map<Collection, Map<string, DocumentData>> {
    return this.working ?? this.docs;
  }

  private requireWorking(): Map<Collection, Map<string, DocumentData>> {
    if (this.working === null) throw new Error('書き込みは transact の中でだけ行えます');
    return this.working;
  }

  private table(
    tables: Map<Collection, Map<string, DocumentData>>,
    collection: Collection
  ): Map<string, DocumentData> {
    let table = tables.get(collection);
    if (table === undefined) {
      table = new Map();
      tables.set(collection, table);
    }
    return table;
  }
}

function cloneTables(
  tables: Map<Collection, Map<string, DocumentData>>
): Map<Collection, Map<string, DocumentData>> {
  return new Map([...tables].map(([collection, table]) => [collection, new Map(table)]));
}
