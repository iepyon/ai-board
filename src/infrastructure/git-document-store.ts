import * as fs from 'node:fs';
import * as path from 'node:path';
import { err, isErr, ok, type Result } from '../shared/result.js';
import { compareStrings } from '../shared/compare.js';
import type { CliError, CliRunner } from './cli-runner.js';
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
import { gitIn, gitReadError, readBlobs, type Git, type GitReadError } from './git-objects.js';

// ============================================================
// git の置き場所 — 置き場所のブランチのファイルを読み、書き込みはコミットとして push する
// ============================================================

/**
 * 文書と置き場所のファイルの行き来。どのコレクションをどのファイルに置くかは、使う側（`cards/composition.ts`）が決める。
 *
 * - `toDocument`: 置き場所のファイル 1 つを文書にする。置き場所の文書でない・読めないなら null（読み飛ばす）
 * - `toFile`: 文書をファイルにする（`path` はリポジトリのルートからの相対）
 * - `roots`: `ls-tree` で並べる範囲（リポジトリのルートからの相対）。ここに無いファイルは読まない
 * - `isDocumentFile`: 置き場所の文書になるファイルか。偽のファイル（計画・画像など）は中身を読まない
 *   （置き場所のファイルは UTF-8 のテキストだが、同じディレクトリにほかのファイルが置かれることがある）
 * - `localCollections`: 置き場所のブランチに載せず、手元（`localDir`）に JSON で置くコレクション。`toFile` には渡らない
 */
export interface DocumentFileCodec {
  readonly roots: readonly string[];
  readonly localCollections: readonly Collection[];
  isDocumentFile(filePath: string): boolean;
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
  /** git に載せないもの（`codec.localCollections` の文書・ロック・一時の index）を置くディレクトリ */
  readonly localDir: string;
  readonly codec: DocumentFileCodec;
  /** fetch と push に使うので、上限を長くしたものを渡す */
  readonly runner: CliRunner;
  readonly lockOptions?: LockOptions;
}

/** fetch した置き場所の先頭を置く参照。追跡ブランチや `FETCH_HEAD` を、ほかの git の操作と取り合わない */
export const STORE_REF = 'refs/ai-board/store';

/** push が先を越されたときに、取り直して走らせ直す回数 */
const MAX_PUSH_ATTEMPTS = 3;

/**
 * 手元のロックの既定。ロックは fetch と、`MAX_PUSH_ATTEMPTS` 回までの push と取り直しをまたいで持つので、
 * ほかのプロセスはネットワークの上限（呼び出し側の runner。既定の組み立てでは 60 秒）より長く待つ
 */
export const GIT_STORE_LOCK_OPTIONS: LockOptions = { ...defaultLockOptions, timeoutMs: 600_000 };

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
 *   push が通らなかったときは取り直し、先頭が動いていれば（先を越された）`op` を最初から走らせ直す（`MAX_PUSH_ATTEMPTS` 回まで）。
 *   先頭が動いていなければ（権限が無い・保護されている・届かない）、やり直さずに push の失敗を返す
 * - 置き場所のファイルへの書き込みが無ければ（`codec.localCollections` だけ・何も書かない）、fetch・コミット・push をしない
 * - 外部コマンドは `CliRunner` に閉じ、引数は配列で渡す（shell を介さない）
 */
export class GitDocumentStore implements DocumentStore {
  private readonly lockPath: string;
  private readonly lockOptions: LockOptions;
  /** 置き場所の先頭のコミット。置き場所のブランチがまだ無ければ null。読み込む前は undefined */
  private head: string | null | undefined = undefined;
  private docs = new Map<string, DocumentData>();
  private written: Map<string, Written> | null = null;
  private readonly git: Git;

  constructor(private readonly options: GitDocumentStoreOptions) {
    this.lockPath = path.join(options.localDir, LOCK_FILE);
    this.lockOptions = options.lockOptions ?? GIT_STORE_LOCK_OPTIONS;
    this.git = gitIn(options.runner, options.repoDir);
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

  /**
   * 書き込みの 1 操作。置き場所を読み込んでいなければ読み込み、形の版（`board/meta`）を確かめてから `op` を走らせる。
   * 置き場所が始まっていない・形の版が違うときは `op` を走らせない（`board.yaml` の無い置き場所や、古い形のカードを push しない）
   */
  transact<T, E>(
    label: TransactLabel<T>,
    op: () => Promise<Result<T, E>>
  ): Promise<Result<T, E | StoreError>> {
    return this.transactWith(label, op, true);
  }

  private async transactWith<T, E>(
    label: TransactLabel<T>,
    op: () => Promise<Result<T, E>>,
    requireMeta: boolean
  ): Promise<Result<T, E | StoreError>> {
    const locked = await this.locked(async (): Promise<Result<T, E | StoreError>> => {
      if (this.head === undefined) {
        const loaded = await this.load();
        if (isErr(loaded)) return loaded;
      }
      const checked = this.checkMetaIf(requireMeta);
      if (isErr(checked)) return checked;

      for (let attempt = 1; ; attempt++) {
        const ran = await this.runOp(op);
        if (!ran.result.ok) return ran.result;

        const settled = await this.settle(labelOf(label, ran.result.value), ran.written);
        if (settled.ok) return ran.result;
        if (settled.error.type !== 'Rejected') return err(settled.error);
        if (attempt >= MAX_PUSH_ATTEMPTS)
          return err({ type: 'StorePushConflict', attempts: attempt });
        // 先を越された。取り直した先頭で読み直し、最新のカードに対して検査からやり直す
        const reloaded = await this.loadAt(settled.error.head);
        if (isErr(reloaded)) return reloaded;
        const rechecked = this.checkMetaIf(requireMeta);
        if (isErr(rechecked)) return rechecked;
      }
    });
    if (isErr(locked)) return locked;
    return locked.value;
  }

  /** 置き場所の形の版を確かめる（`store init` の書き込みでは確かめない） */
  private checkMetaIf(requireMeta: boolean): Result<void, StoreError> {
    return requireMeta ? checkMeta(this) : ok(undefined);
  }

  /** `op` を走らせ、その中の書き込みを集める。例外なら書き込みを捨ててそのまま投げる */
  private async runOp<T, E>(
    op: () => Promise<Result<T, E>>
  ): Promise<{ result: Result<T, E>; written: Map<string, Written> }> {
    const written = new Map<string, Written>();
    this.written = written;
    try {
      return { result: await op(), written };
    } finally {
      this.written = null;
    }
  }

  /** 書き込みを確定する。置き場所のファイルになるものはコミットして push し、手元のものは手元に書く */
  private async settle(
    message: string,
    written: Map<string, Written>
  ): Promise<Result<void, StoreError | PushRejected>> {
    const { remote, local } = this.split(written);
    if (remote.size > 0) {
      const pushed = await this.commitAndPush(message, remote);
      if (isErr(pushed)) return pushed;
      this.head = pushed.value;
    }
    await this.writeLocal(local);
    for (const [key, value] of written) {
      if (value === DELETED) this.docs.delete(key);
      else this.docs.set(key, value);
    }
    return ok(undefined);
  }

  /**
   * 空の置き場所に最初の文書を書く（`ai-board store init`）。置き場所に既に `board/meta` があれば `StoreAlreadyInitialized`。
   * 確かめは書き込みの 1 操作の中で行う。2 台が同時に始めて push が先を越されたら、取り直した置き場所で確かめ直して拒む
   * （先に入った並び順を空で上書きしない）
   */
  async initialize(
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
    return this.loadAt(fetched.value);
  }

  /** fetch 済みの先頭（無ければ null）の置き場所のファイルと、手元の文書を読み直す */
  private async loadAt(head: string | null): Promise<Result<void, StoreError>> {
    const docs = new Map<string, DocumentData>();
    if (head !== null) {
      const { codec } = this.options;
      const files = await readBlobs(this.git, head, codec.roots, (filePath) =>
        codec.isDocumentFile(filePath)
      );
      if (isErr(files)) return err(storeGitFailed(files.error));
      for (const file of files.value) {
        const doc = codec.toDocument(file.path, file.content);
        if (doc !== null) docs.set(keyOf(doc.collection, doc.id), doc.data);
      }
    }
    for (const doc of this.readLocal()) docs.set(keyOf(doc.collection, doc.id), doc.data);

    this.head = head;
    this.docs = docs;
    return ok(undefined);
  }

  /**
   * 置き場所のブランチの先頭を `STORE_REF` に取る。ブランチがまだ無ければ null。
   * まず fetch だけを走らせ、失敗したときだけ、リモートが無いのか・ブランチが無いのか・届かないのかを見分ける
   */
  private async fetchHead(): Promise<Result<string | null, StoreError>> {
    const { remote, branch } = this.options;
    const fetched = await this.git([
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      remote,
      `+refs/heads/${branch}:${STORE_REF}`,
    ]);
    if (isErr(fetched)) return this.diagnoseFetch(fetched.error);

    const head = await this.git(['rev-parse', '--verify', `${STORE_REF}^{commit}`]);
    if (isErr(head)) return err(gitFailed('rev-parse', head.error));
    return ok(head.value.trim());
  }

  private async diagnoseFetch(error: CliError): Promise<Result<null, StoreError>> {
    const { remote, branch } = this.options;
    if (isRemoteName(remote) && isErr(await this.git(['remote', 'get-url', remote]))) {
      return err({ type: 'StoreRemoteMissing', remote });
    }
    const listed = await this.git(['ls-remote', '--heads', remote, `refs/heads/${branch}`]);
    if (listed.ok && listed.value.trim() === '') {
      await this.git(['update-ref', '-d', STORE_REF]);
      return ok(null);
    }
    return err(gitFailed('fetch', error));
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
      (this.options.codec.localCollections.includes(collection) ? local : remote).set(key, value);
    }
    return { remote, local };
  }

  /**
   * 書き込みを先頭の上のコミットにして push する。成功すれば新しい先頭。
   * push が通らなかったら取り直し、先頭が動いていれば `Rejected`（先を越された）、動いていなければ push の失敗を返す
   */
  private async commitAndPush(
    message: string,
    writes: Map<string, Written>
  ): Promise<Result<string, StoreError | PushRejected>> {
    const parent = this.head ?? null;
    const commit = await this.buildCommit(message, writes, parent);
    if (isErr(commit)) return commit;
    const sha = commit.value;

    const pushed = await this.git([
      'push',
      '--porcelain',
      this.options.remote,
      `${sha}:refs/heads/${this.options.branch}`,
    ]);
    // 「既に最新」は、同じ親・同じ中身・同じ時刻のコミットを、ほかのプロセスが先に push したということ。
    // 自分の書き込みが通ったとは読まず、通らなかったときと同じく取り直して見分ける
    if (isErr(pushed) || isUpToDate(pushed.value)) {
      const latest = await this.fetchHead();
      if (isErr(latest)) return latest;
      if (latest.value !== parent) return err({ type: 'Rejected', head: latest.value });
      return err(
        isErr(pushed)
          ? gitFailed('push', pushed.error)
          : { type: 'StoreGitFailed', operation: 'push', message: '置き場所の先頭が動いていません' }
      );
    }

    await this.git(['update-ref', STORE_REF, sha]);
    return ok(sha);
  }

  /** 一時の index で、`parent`（無ければ空）の上に書き込みを足したコミットを作る */
  private async buildCommit(
    message: string,
    writes: Map<string, Written>,
    parent: string | null
  ): Promise<Result<string, StoreError>> {
    const indexFile = path.join(
      this.options.localDir,
      `index-${process.pid}-${Date.now().toString(36)}`
    );
    const env = { GIT_INDEX_FILE: indexFile };
    try {
      fs.mkdirSync(this.options.localDir, { recursive: true });
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
      return ok(commit.value.trim());
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
    for (const collection of this.options.codec.localCollections) {
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

  private requireWritten(): Map<string, Written> {
    if (this.written === null) throw new Error('書き込みは transact の中でだけ行えます');
    return this.written;
  }
}

const ZERO_OBJECT = '0000000000000000000000000000000000000000';

/** push が先を越された。`head` は取り直した置き場所の先頭 */
interface PushRejected {
  readonly type: 'Rejected';
  readonly head: string | null;
}

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

/** リモートの名前か（パスや URL でないか）。fetch に失敗したとき、名前ならリポジトリに設定があるかを確かめる */
export function isRemoteName(remote: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(remote) && !remote.startsWith('.');
}

function gitFailed(operation: string, error: CliError): StoreError {
  return storeGitFailed(gitReadError(operation, error));
}

function storeGitFailed(error: GitReadError): StoreError {
  return { type: 'StoreGitFailed', operation: error.operation, message: error.message };
}
