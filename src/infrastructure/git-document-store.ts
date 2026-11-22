import * as fs from 'node:fs';
import * as path from 'node:path';
import { err, isErr, ok, type Result } from '../shared/result.js';
import { compareStrings } from '../shared/compare.js';
import type { CliRunner } from './cli-runner.js';
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
// git の置き場所 — 置き場所のブランチのファイルを読み、書き込みはコミットとして push する
// ============================================================

/**
 * 文書と置き場所のファイルの行き来。どのコレクションをどのファイルに置くかは、使う側（`cards/composition.ts`）が決める。
 *
 * - `toDocument`: 置き場所のファイル 1 つを文書にする。置き場所の文書でない・読めないなら null（読み飛ばす）
 * - `toFile`: 文書をファイルにする（`path` はリポジトリのルートからの相対）
 * - `roots`: `ls-tree` で読む範囲（リポジトリのルートからの相対）。ここに無いファイルは読まない
 */
export interface DocumentFileCodec {
  readonly roots: readonly string[];
  toDocument(
    filePath: string,
    content: string
  ): { readonly collection: Collection; readonly id: string; readonly data: DocumentData } | null;
  toFile(
    collection: Collection,
    id: string,
    data: DocumentData
  ): { readonly path: string; readonly content: string };
}

export interface GitDocumentStoreOptions {
  /** git を走らせるリポジトリ（メインのチェックアウト）。オブジェクトはここに作る */
  readonly repoDir: string;
  /** 置き場所のリモート。リモートの名前か、リポジトリのパス・URL */
  readonly remote: string;
  /** 置き場所のブランチ */
  readonly branch: string;
  /** git に載せないもの（`localCollections` の文書・ロック・一時の index）を置くディレクトリ */
  readonly localDir: string;
  /** 置き場所のブランチに載せず、`localDir` に JSON で置くコレクション */
  readonly localCollections: readonly Collection[];
  readonly codec: DocumentFileCodec;
  /** fetch と push に使うので、上限を長くしたものを渡す */
  readonly runner: CliRunner;
  readonly lockOptions?: LockOptions;
}

/** fetch した置き場所の先頭を置く参照。追跡ブランチや `FETCH_HEAD` を、ほかの git の操作と取り合わない */
export const STORE_REF = 'refs/ai-board/store';

/** push が先を越されたときに、取り直して走らせ直す回数 */
export const MAX_PUSH_ATTEMPTS = 3;

const LOCK_FILE = 'store.lock';
const DELETED = Symbol('deleted');
type Written = DocumentData | typeof DELETED;

/**
 * 置き場所のブランチ（既定は `origin` の `main`）の `.ai-board/` のファイルを、文書として読み書きする。
 *
 * - `check()` で、手元のロックを取って置き場所の先頭を `STORE_REF` へ fetch し、`codec.roots` の下のファイルを全部メモリに読む。
 *   `get` / `list` はこのメモリから返す
 * - `transact` は、`op` の書き込みのうち置き場所のファイルになるものを、一時の index で先頭の上のコミットにして push する。
 *   メインのチェックアウトの作業ツリー・index・今のブランチには触らない。
 *   push が拒まれたら取り直し、`op` を最初から走らせ直す（`MAX_PUSH_ATTEMPTS` 回まで）
 * - 置き場所のファイルへの書き込みが無ければ（`localCollections` だけ・何も書かない）、fetch・コミット・push をしない
 * - 外部コマンドは `CliRunner` に閉じ、引数は配列で渡す（shell を介さない）
 */
export class GitDocumentStore implements DocumentStore {
  private readonly lockPath: string;
  private readonly lockOptions: LockOptions;
  /** 置き場所の先頭のコミット。置き場所のブランチがまだ無ければ null。読み込む前は undefined */
  private head: string | null | undefined = undefined;
  private docs = new Map<string, DocumentData>();
  private written: Map<string, Written> | null = null;

  constructor(private readonly options: GitDocumentStoreOptions) {
    this.lockPath = path.join(options.localDir, LOCK_FILE);
    this.lockOptions = options.lockOptions ?? defaultLockOptions;
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

  pendingWrites(): number {
    return 0;
  }

  async transact<T, E>(
    label: TransactLabel<T>,
    op: () => Promise<Result<T, E>>
  ): Promise<Result<T, E | StoreError>> {
    const locked = await this.locked(async (): Promise<Result<T, E | StoreError>> => {
      if (this.head === undefined) {
        const loaded = await this.load();
        if (isErr(loaded)) return loaded;
      }

      for (let attempt = 1; ; attempt++) {
        this.written = new Map();
        let result: Result<T, E>;
        try {
          result = await op();
        } catch (error) {
          this.written = null;
          throw error;
        }
        const written = this.written;
        this.written = null;
        if (!result.ok) return result;

        const { remote, local } = this.split(written);
        if (remote.size > 0) {
          const pushed = await this.commitAndPush(labelOf(label, result.value), remote);
          if (isErr(pushed)) {
            if (attempt >= MAX_PUSH_ATTEMPTS) {
              return err({ type: 'StorePushConflict', attempts: attempt });
            }
            // 先を越された（か、届かなかった）。取り直して、最新のカードに対して検査からやり直す
            const reloaded = await this.load();
            if (isErr(reloaded)) return reloaded;
            continue;
          }
          this.head = pushed.value;
        }
        await this.writeLocal(local);
        for (const [key, value] of written) {
          if (value === DELETED) this.docs.delete(key);
          else this.docs.set(key, value);
        }
        return result;
      }
    });
    if (isErr(locked)) return locked;
    return locked.value;
  }

  /**
   * 空の置き場所に最初の文書を書く（`ai-board store init`）。置き場所に既に `board/meta` があれば `StoreAlreadyInitialized`
   */
  async initialize(
    docs: readonly { collection: Collection; id: string; data: DocumentData }[]
  ): Promise<Result<void, StoreError>> {
    const loaded = await this.locked(() => this.load());
    if (isErr(loaded)) return loaded;
    if (isErr(loaded.value)) return loaded.value;
    if (this.get('board', 'meta') !== null) return err({ type: 'StoreAlreadyInitialized' });
    return this.transact('置き場所を始める', () => {
      for (const doc of docs) this.set(doc.collection, doc.id, doc.data);
      return Promise.resolve(ok(undefined));
    });
  }

  /** 置き場所の先頭のコミット（`check()` の後）。置き場所のブランチがまだ無ければ null */
  headCommit(): string | null {
    return this.head ?? null;
  }

  // ------------------------------------------------------------
  // 読み込み
  // ------------------------------------------------------------

  /** 置き場所の先頭を fetch し、置き場所のファイルと手元の文書を全部読み直す。ロックの中で呼ぶ */
  private async load(): Promise<Result<void, StoreError>> {
    const fetched = await this.fetchHead();
    if (isErr(fetched)) return fetched;

    const docs = new Map<string, DocumentData>();
    if (fetched.value !== null) {
      const files = await this.readTree(fetched.value);
      if (isErr(files)) return files;
      for (const file of files.value) {
        const doc = this.options.codec.toDocument(file.path, file.content);
        if (doc !== null) docs.set(keyOf(doc.collection, doc.id), doc.data);
      }
    }
    for (const doc of this.readLocal()) docs.set(keyOf(doc.collection, doc.id), doc.data);

    this.head = fetched.value;
    this.docs = docs;
    return ok(undefined);
  }

  /** 置き場所のブランチの先頭を `STORE_REF` に取る。ブランチがまだ無ければ null */
  private async fetchHead(): Promise<Result<string | null, StoreError>> {
    const { remote, branch } = this.options;
    if (isRemoteName(remote)) {
      const known = await this.git(['remote', 'get-url', remote]);
      if (isErr(known)) return err({ type: 'StoreRemoteMissing', remote });
    }

    const listed = await this.git(['ls-remote', '--heads', remote, `refs/heads/${branch}`]);
    if (isErr(listed)) return err(gitFailed('ls-remote', listed.error));
    if (listed.value.trim() === '') {
      await this.git(['update-ref', '-d', STORE_REF]);
      return ok(null);
    }

    const fetched = await this.git([
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      remote,
      `+refs/heads/${branch}:${STORE_REF}`,
    ]);
    if (isErr(fetched)) return err(gitFailed('fetch', fetched.error));

    const head = await this.git(['rev-parse', '--verify', `${STORE_REF}^{commit}`]);
    if (isErr(head)) return err(gitFailed('rev-parse', head.error));
    return ok(head.value.trim());
  }

  /** コミットの `codec.roots` の下のファイルを全部読む */
  private async readTree(
    commit: string
  ): Promise<Result<readonly { path: string; content: string }[], StoreError>> {
    const listed = await this.git([
      'ls-tree',
      '-r',
      '-z',
      commit,
      '--',
      ...this.options.codec.roots,
    ]);
    if (isErr(listed)) return err(gitFailed('ls-tree', listed.error));

    const entries = listed.value
      .split('\0')
      .filter((line) => line !== '')
      .flatMap((line) => {
        const tab = line.indexOf('\t');
        const [, type, object] = line.slice(0, tab).split(' ');
        return type === 'blob' && object !== undefined
          ? [{ object, path: line.slice(tab + 1) }]
          : [];
      });
    if (entries.length === 0) return ok([]);

    const read = await this.git(['cat-file', '--batch'], {
      input: entries.map((entry) => `${entry.object}\n`).join(''),
    });
    if (isErr(read)) return err(gitFailed('cat-file', read.error));

    const contents = parseCatFileBatch(read.value);
    if (contents.length !== entries.length) {
      return err({
        type: 'StoreGitFailed',
        operation: 'cat-file',
        message: '読んだ中身の数がファイルの数と合いません',
      });
    }
    return ok(entries.map((entry, i) => ({ path: entry.path, content: contents[i] ?? '' })));
  }

  // ------------------------------------------------------------
  // 書き込み
  // ------------------------------------------------------------

  private split(written: Map<string, Written>): {
    remote: Map<string, Written>;
    local: Map<string, Written>;
  } {
    const remote = new Map<string, Written>();
    const local = new Map<string, Written>();
    for (const [key, value] of written) {
      const { collection } = parseKey(key);
      (this.options.localCollections.includes(collection) ? local : remote).set(key, value);
    }
    return { remote, local };
  }

  /** 書き込みを先頭の上のコミットにして push する。成功すれば新しい先頭 */
  private async commitAndPush(
    message: string,
    writes: Map<string, Written>
  ): Promise<Result<string, StoreError>> {
    const indexFile = path.join(
      this.options.localDir,
      `index-${process.pid}-${Date.now().toString(36)}`
    );
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      fs.mkdirSync(this.options.localDir, { recursive: true });
      const parent = this.head ?? null;
      const readTree = await this.git(
        parent === null ? ['read-tree', '--empty'] : ['read-tree', parent],
        { env }
      );
      if (isErr(readTree)) return err(gitFailed('read-tree', readTree.error));

      const lines = await this.indexLines(writes);
      if (isErr(lines)) return lines;
      const updated = await this.git(['update-index', '--index-info'], {
        env,
        input: lines.value.map((line) => `${line}\n`).join(''),
      });
      if (isErr(updated)) return err(gitFailed('update-index', updated.error));

      const tree = await this.git(['write-tree'], { env });
      if (isErr(tree)) return err(gitFailed('write-tree', tree.error));

      const commit = await this.git([
        'commit-tree',
        tree.value.trim(),
        ...(parent === null ? [] : ['-p', parent]),
        '-m',
        `chore(board): ${message}`,
      ]);
      if (isErr(commit)) return err(gitFailed('commit-tree', commit.error));
      const sha = commit.value.trim();

      const pushed = await this.git([
        'push',
        '--porcelain',
        this.options.remote,
        `${sha}:refs/heads/${this.options.branch}`,
      ]);
      if (isErr(pushed)) return err(gitFailed('push', pushed.error));
      // 「既に最新」は、同じ親・同じ中身・同じ時刻のコミットを、ほかのプロセスが先に push したということ。
      // 自分の書き込みが通ったとは読まず、先を越されたものとして取り直す
      if (isUpToDate(pushed.value)) {
        return err({
          type: 'StoreGitFailed',
          operation: 'push',
          message: '既に同じコミットがあります',
        });
      }

      await this.git(['update-ref', STORE_REF, sha]);
      return ok(sha);
    } finally {
      fs.rmSync(indexFile, { force: true });
    }
  }

  /** 書き込みを `update-index --index-info` の行にする。足す中身は blob として先に書く */
  private async indexLines(writes: Map<string, Written>): Promise<Result<string[], StoreError>> {
    const lines: string[] = [];
    for (const [key, value] of writes) {
      const { collection, id } = parseKey(key);
      if (value === DELETED) {
        const current = this.docs.get(key);
        if (current === undefined) continue;
        const file = this.options.codec.toFile(collection, id, current);
        lines.push(`0 ${ZERO_OBJECT}\t${file.path}`);
        continue;
      }
      const file = this.options.codec.toFile(collection, id, value);
      const blob = await this.git(['hash-object', '-w', '--stdin'], { input: file.content });
      if (isErr(blob)) return err(gitFailed('hash-object', blob.error));
      lines.push(`100644 ${blob.value.trim()}\t${file.path}`);
    }
    return ok(lines);
  }

  // ------------------------------------------------------------
  // 手元の文書（git に載せないコレクション）
  // ------------------------------------------------------------

  private readLocal(): { collection: Collection; id: string; data: DocumentData }[] {
    const docs: { collection: Collection; id: string; data: DocumentData }[] = [];
    for (const collection of this.options.localCollections) {
      const dir = path.join(this.options.localDir, collection);
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
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
    }
    return docs;
  }

  private async writeLocal(writes: Map<string, Written>): Promise<void> {
    for (const [key, value] of writes) {
      const { collection, id } = parseKey(key);
      const dir = path.join(this.options.localDir, collection);
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

  // ------------------------------------------------------------
  // ヘルパー
  // ------------------------------------------------------------

  private async locked<T>(op: () => Promise<T>): Promise<Result<T, StoreError>> {
    fs.mkdirSync(this.options.localDir, { recursive: true });
    const result = await withFileLock(this.lockPath, this.lockOptions, op);
    if (isErr(result)) return err({ type: 'StoreLockTimeout', lockPath: result.error.lockPath });
    return result;
  }

  private git(
    args: readonly string[],
    options: { env?: Record<string, string>; input?: string } = {}
  ): ReturnType<CliRunner['run']> {
    return this.options.runner.run('git', ['-C', this.options.repoDir, ...args], options);
  }

  private requireWritten(): Map<string, Written> {
    if (this.written === null) throw new Error('書き込みは transact の中でだけ行えます');
    return this.written;
  }
}

const ZERO_OBJECT = '0000000000000000000000000000000000000000';

function keyOf(collection: Collection, id: string): string {
  return `${collection}/${id}`;
}

function parseKey(key: string): { collection: Collection; id: string } {
  const at = key.indexOf('/');
  return { collection: key.slice(0, at) as Collection, id: key.slice(at + 1) };
}

/** `git push --porcelain` の出力で、ref が「既に最新」（`=`）だったか */
export function isUpToDate(porcelain: string): boolean {
  return porcelain.split('\n').some((line) => line.startsWith('=\t'));
}

/** リモートの名前か（パスや URL でないか）。名前なら、リポジトリに設定があるかを先に確かめる */
export function isRemoteName(remote: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(remote) && !remote.startsWith('.');
}

function gitFailed(operation: string, error: { readonly type: string }): StoreError {
  const message =
    'message' in error && typeof error.message === 'string' ? error.message : error.type;
  return { type: 'StoreGitFailed', operation, message };
}

/**
 * `git cat-file --batch` の出力を、blob ごとの中身に分ける。
 * 見出しの大きさはバイト数なので、UTF-8 のバイト列に戻してから切り出す（置き場所のファイルは UTF-8 のテキスト）
 */
export function parseCatFileBatch(output: string): string[] {
  const bytes = Buffer.from(output, 'utf-8');
  const contents: string[] = [];
  let at = 0;
  while (at < bytes.length) {
    const newline = bytes.indexOf(0x0a, at);
    if (newline < 0) break;
    const header = bytes.subarray(at, newline).toString('utf-8').split(' ');
    const size = Number(header[2]);
    if (header[1] === 'missing' || !Number.isInteger(size)) {
      contents.push('');
      at = newline + 1;
      continue;
    }
    contents.push(bytes.subarray(newline + 1, newline + 1 + size).toString('utf-8'));
    at = newline + 1 + size + 1;
  }
  return contents;
}

/**
 * 文書を `<root>/<collection>/<id>.json` に置くコーデック。契約テストと、文書の形を問わない試しに使う
 */
export function jsonFileCodec(root: string): DocumentFileCodec {
  const prefix = `${root}/`;
  return {
    roots: [root],
    toDocument(filePath, content) {
      if (!filePath.startsWith(prefix) || !filePath.endsWith('.json')) return null;
      const [collection, name, ...rest] = filePath.slice(prefix.length).split('/');
      if (collection === undefined || name === undefined || rest.length > 0) return null;
      const id = name.slice(0, -'.json'.length);
      try {
        return {
          collection: collection as Collection,
          id,
          data: JSON.parse(content) as DocumentData,
        };
      } catch {
        return null;
      }
    },
    toFile(collection, id, data) {
      return { path: `${prefix}${collection}/${id}.json`, content: `${JSON.stringify(data)}\n` };
    },
  };
}
