import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { err, isErr, ok, type Result } from '../shared/result.js';
import { describeCliError, type CliError, type CliRunner } from './cli-runner.js';

// ============================================================
// データ用ブランチ — カードの正本を置く git のワークツリーの読み書き
// ============================================================

/** カードの正本を置く orphan のブランチ */
export const DATA_BRANCH = 'ai-board/data';

/**
 * データ用ブランチを取り直すときの refspec。
 *
 * ブランチ名だけで fetch すると、単一ブランチや浅い clone（クラウドの clone がそうでありうる）では
 * `FETCH_HEAD` しか更新されず、追跡のブランチが古いまま残る。追跡のブランチまで明示して更新する。
 */
export const DATA_REMOTE_REF = `refs/remotes/origin/${DATA_BRANCH}`;
const DATA_FETCH_REFSPEC = `+refs/heads/${DATA_BRANCH}:${DATA_REMOTE_REF}`;
const DATA_PUSH_REFSPEC = `HEAD:refs/heads/${DATA_BRANCH}`;

/** 手元の複数のプロセスの書き込みを直列にするロックファイル。データのワークツリーの親に置く */
export const LOCK_FILE = 'data.lock';

/** ロックを待つ上限 */
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/** ロックが空くのを確かめ直す間隔 */
const DEFAULT_LOCK_POLL_MS = 50;

/** push が拒否されたとき、取り直して頭からやり直す回数の上限（最初の 1 回を含まない） */
export const DEFAULT_MAX_RETRIES = 3;

/**
 * データ用ブランチの読み書きが失敗した理由。
 *
 * git の stderr には資格情報が混じりうるので、`CliRunner` と同じく理由は終了コードまでにとどめる。
 */
export type DataStoreError =
  /** データのワークツリーが無く、`origin`（または手元）にデータ用ブランチも無い */
  | { readonly type: 'DataBranchMissing'; readonly dataDir: string }
  /** データのワークツリーの場所が、git のワークツリーではない */
  | { readonly type: 'DataDirNotRepository'; readonly dataDir: string }
  /** ほかのプロセスがロックを持ったまま、待つ上限を過ぎた */
  | { readonly type: 'DataStoreLockTimeout'; readonly lockPath: string }
  /** 書き込みの前の取り直しで fetch に失敗した（オフラインなど）。push できないので書けない */
  | { readonly type: 'DataStoreFetchFailed'; readonly message: string }
  /** push に失敗した（ネットワーク、拒否が上限まで続いた） */
  | { readonly type: 'DataStorePushFailed'; readonly attempts: number; readonly message: string }
  /** fetch / push 以外の git の操作に失敗した */
  | { readonly type: 'DataStoreGitFailed'; readonly step: string; readonly message: string };

/** 取り直しの結果 */
export type RefreshOutcome =
  /** `origin` の最新に合わせた */
  | { readonly kind: 'fetched' }
  /** `origin` が無い（テスト用など）。手元のコミットに合わせた */
  | { readonly kind: 'no-origin' }
  /** fetch に失敗した。手元の内容のまま読む。書き込みは push できないので失敗する */
  | { readonly kind: 'offline'; readonly reason: string };

/**
 * `transact` に渡す、書き込みの中身。
 *
 * データのワークツリーの場所を受け取り、今のカードを読んで、検査して、ファイルを書く。
 * Err を返せば（検査で拒んだ）、書いたファイルは捨ててコミットしない。
 * push が拒否されると取り直した状態で頭から呼び直されるので、外へ副作用を残さないこと。
 */
export type DataOperation<T, E> = (dataDir: string) => Promise<Result<T, E>>;

/** コミットのメッセージ。理由の文字列は入れず、ID・ゲート・種別だけを入れる */
export type CommitMessage<T> = string | ((value: T) => string);

export interface DataStore {
  /** データのワークツリー */
  readonly dataDir: string;

  /**
   * データのワークツリーを用意する。既にあれば何もしない。
   *
   * 無ければ `repoRoot` から、データ用ブランチを fetch して `git worktree add` する。
   */
  prepare(): Promise<Result<void, DataStoreError>>;

  /** ロックを取り、`origin` の最新に合わせ直す。読み出しの前に 1 回呼ぶ */
  refresh(): Promise<Result<RefreshOutcome, DataStoreError>>;

  /**
   * 書き込みの 1 操作。
   *
   * ロックを取る → 取り直す → `op` → コミット → push → ロックを放す、をまとめて行う。
   * push が拒否されたら rebase せず、取り直して `op` を頭から走らせる（`maxRetries` 回まで）。
   * `op` が何も書かなければコミットしない。
   */
  transact<T, E>(
    message: CommitMessage<T>,
    op: DataOperation<T, E>
  ): Promise<Result<T, E | DataStoreError>>;
}

export interface DataStoreOptions {
  /** データのワークツリー */
  readonly dataDir: string;
  /** データのワークツリーが無いとき、`git worktree add` するリポジトリ。無ければ作らずに失敗する */
  readonly repoRoot?: string;
  readonly runner: CliRunner;
  /** 既定は `<dataDir の親>/data.lock` */
  readonly lockPath?: string;
  readonly lockTimeoutMs?: number;
  readonly lockPollMs?: number;
  readonly maxRetries?: number;
  /** ロックの持ち主が生きているか。テストで差し替える */
  readonly isAlive?: (pid: number) => boolean;
}

/**
 * データ用ブランチのワークツリーを読み書きする。
 *
 * git はすべて `CliRunner` を通し、引数は配列で渡す。カード ID や理由をコマンド文字列に入れない。
 */
export function createDataStore(options: DataStoreOptions): DataStore {
  return new GitDataStore(options);
}

/** push に失敗した試みの、土台（そのときの `origin` の先頭）と失敗の理由 */
interface Rejected {
  readonly base: string;
  readonly error: CliError;
}

/** 1 回の試みの結果。push に失敗したら、拒否かもしれないので取り直してやり直す */
type Attempt<T, E> =
  | { readonly kind: 'done'; readonly result: Result<T, E | DataStoreError> }
  | ({ readonly kind: 'rejected' } & Rejected);

class GitDataStore implements DataStore {
  readonly dataDir: string;
  private readonly repoRoot: string | null;
  private readonly runner: CliRunner;
  private readonly lockPath: string;
  private readonly lockOptions: LockOptions;
  private readonly maxRetries: number;

  /**
   * 同じプロセスの中の操作を順に並べる。
   *
   * ロックファイルは pid で持ち主を見るので、同じプロセスの 2 つの操作は互いを「生きている持ち主」として
   * 待ち合うだけになる。待つ上限で失敗しないよう、手前で 1 列に並べておく。
   */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: DataStoreOptions) {
    this.dataDir = path.resolve(options.dataDir);
    this.repoRoot = options.repoRoot === undefined ? null : path.resolve(options.repoRoot);
    this.runner = options.runner;
    this.lockPath = options.lockPath ?? path.join(path.dirname(this.dataDir), LOCK_FILE);
    this.lockOptions = {
      timeoutMs: options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      pollMs: options.lockPollMs ?? DEFAULT_LOCK_POLL_MS,
      isAlive: options.isAlive ?? isProcessAlive,
    };
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  }

  async prepare(): Promise<Result<void, DataStoreError>> {
    const dataDir = this.dataDir;
    if (fs.existsSync(path.join(dataDir, '.git'))) return ok(undefined);
    if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length > 0) {
      return err({ type: 'DataDirNotRepository', dataDir });
    }
    if (this.repoRoot === null) return err({ type: 'DataBranchMissing', dataDir });

    return this.addWorktree(this.repoRoot);
  }

  async refresh(): Promise<Result<RefreshOutcome, DataStoreError>> {
    const prepared = await this.prepare();
    if (isErr(prepared)) return prepared;

    return this.withLock(() => this.sync());
  }

  async transact<T, E>(
    message: CommitMessage<T>,
    op: DataOperation<T, E>
  ): Promise<Result<T, E | DataStoreError>> {
    const prepared = await this.prepare();
    if (isErr(prepared)) return prepared;

    return this.withLock(async () => {
      let rejected: Rejected | null = null;

      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        const outcome: Attempt<T, E> = await this.attempt(message, op, attempt, rejected);
        if (outcome.kind === 'done') return outcome.result;
        rejected = outcome;
      }

      // 押し出せなかったコミットを手元に残さない。読み出しが書けたものとして読まないように
      await this.discardTo(DATA_REMOTE_REF);
      return err(pushFailed(this.maxRetries + 1, rejected?.error ?? null));
    });
  }

  /** 取り直す → `op` → コミット → push を 1 回試す */
  private async attempt<T, E>(
    message: CommitMessage<T>,
    op: DataOperation<T, E>,
    attempt: number,
    rejected: Rejected | null
  ): Promise<Attempt<T, E>> {
    const done = (result: Result<T, E | DataStoreError>): Attempt<T, E> => ({
      kind: 'done',
      result,
    });

    const base = await this.syncForWrite(attempt, rejected);
    if (isErr(base)) return done(base);

    const written = await this.runOperation(op);
    if (isErr(written)) return done(written);

    const committed = await this.commit(
      typeof message === 'string' ? message : message(written.value)
    );
    if (isErr(committed)) return done(committed);
    if (!committed.value || base.value === null) return done(written);

    const pushed = await this.git(['push', '--quiet', '--no-verify', 'origin', DATA_PUSH_REFSPEC]);
    if (isErr(pushed)) return { kind: 'rejected', base: base.value, error: pushed.error };
    return done(written);
  }

  /**
   * 書き込みの前に取り直し、その試みの土台（`origin` の先頭）を返す。`origin` が無ければ null。
   *
   * 書き込みは push できなければ意味が無いので、fetch の失敗はここで失敗にする。
   */
  private async syncForWrite(
    attempt: number,
    rejected: Rejected | null
  ): Promise<Result<string | null, DataStoreError>> {
    const synced = await this.sync();
    if (isErr(synced)) return synced;

    const outcome = synced.value;
    if (outcome.kind === 'no-origin') return ok(null);
    if (outcome.kind === 'offline') {
      // push の失敗の後に fetch もできない＝拒否ではなくネットワークの失敗
      return err(
        rejected === null
          ? { type: 'DataStoreFetchFailed', message: outcome.reason }
          : pushFailed(attempt, rejected.error)
      );
    }

    const base = await this.remoteTip();
    if (isErr(base)) return base;
    // 取り直しても origin が動いていなければ、拒否ではない（権限など）。やり直しても同じなので止める
    if (rejected !== null && base.value === rejected.base) {
      return err(pushFailed(attempt, rejected.error));
    }
    return base;
  }

  private async addWorktree(repoRoot: string): Promise<Result<void, DataStoreError>> {
    const dataDir = this.dataDir;
    const inRepo = (args: readonly string[]): Promise<Result<string, CliError>> =>
      this.runner.run('git', ['-C', repoRoot, ...args]);

    const remotes = await inRepo(['remote']);
    if (isErr(remotes)) return err(gitFailed('remote', remotes.error));
    const withOrigin = includesOrigin(remotes.value);

    if (withOrigin) {
      // fetch の失敗は「ブランチが無い」と「ネットワーク」を分けられないので、先に有無を問う
      const heads = await inRepo(['ls-remote', '--heads', 'origin', DATA_BRANCH]);
      if (isErr(heads)) return err(fetchFailed(heads.error));
      if (heads.value.trim() === '') return err({ type: 'DataBranchMissing', dataDir });

      const fetched = await inRepo(['fetch', '--quiet', 'origin', DATA_FETCH_REFSPEC]);
      if (isErr(fetched)) return err(fetchFailed(fetched.error));
    }

    const local = await inRepo(['rev-parse', '--verify', '--quiet', `refs/heads/${DATA_BRANCH}`]);
    if (isErr(local) && !withOrigin) return err({ type: 'DataBranchMissing', dataDir });

    const args = isErr(local)
      ? ['worktree', 'add', '--quiet', '-b', DATA_BRANCH, dataDir, DATA_REMOTE_REF]
      : ['worktree', 'add', '--quiet', dataDir, DATA_BRANCH];
    const added = await inRepo(args);
    return isErr(added) ? err(gitFailed('worktree add', added.error)) : ok(undefined);
  }

  /** fetch して `origin` の最新に合わせる。fetch に失敗したら、最後に知っている `origin` の内容に合わせる */
  private async sync(): Promise<Result<RefreshOutcome, DataStoreError>> {
    const remotes = await this.gitStep('remote', ['remote']);
    if (isErr(remotes)) return remotes;

    if (!includesOrigin(remotes.value)) {
      const discarded = await this.discardTo('HEAD');
      return isErr(discarded) ? discarded : ok({ kind: 'no-origin' });
    }

    const fetched = await this.git(['fetch', '--quiet', 'origin', DATA_FETCH_REFSPEC]);
    // 押し出せなかったコミットが残っていても、取り直しの後は origin の内容で読む
    const discarded = await this.discardTo(DATA_REMOTE_REF);
    if (isErr(discarded)) return discarded;

    return isErr(fetched)
      ? ok({ kind: 'offline', reason: describeCliError(fetched.error) })
      : ok({ kind: 'fetched' });
  }

  /**
   * 手元の変更を捨てて、`target` に合わせる。
   *
   * `reset --hard` は追跡していないファイルを残し、次の `git add -A` が拾ってしまうので `clean` も走らせる。
   * 手元にしか無い変更は持たない前提なので、捨ててよい。
   */
  private async discardTo(target: string): Promise<Result<void, DataStoreError>> {
    const reset = await this.gitStep('reset', ['reset', '--hard', '--quiet', target]);
    if (isErr(reset)) return reset;
    const cleaned = await this.gitStep('clean', ['clean', '-fdq']);
    return isErr(cleaned) ? cleaned : ok(undefined);
  }

  private async remoteTip(): Promise<Result<string, DataStoreError>> {
    const tip = await this.gitStep('rev-parse', ['rev-parse', '--verify', DATA_REMOTE_REF]);
    return isErr(tip) ? tip : ok(tip.value.trim());
  }

  /** `op` を走らせる。拒んだときや例外のときは、書きかけのファイルを捨てる */
  private async runOperation<T, E>(
    op: DataOperation<T, E>
  ): Promise<Result<T, E | DataStoreError>> {
    let result: Result<T, E>;
    try {
      result = await op(this.dataDir);
    } catch (error) {
      await this.discardTo('HEAD');
      throw error;
    }

    if (isErr(result)) {
      const discarded = await this.discardTo('HEAD');
      return isErr(discarded) ? discarded : result;
    }
    return result;
  }

  /** 変化があればコミットする。コミットしたかを返す */
  private async commit(message: string): Promise<Result<boolean, DataStoreError>> {
    const status = await this.gitStep('status', ['status', '--porcelain']);
    if (isErr(status)) return status;
    if (status.value.trim() === '') return ok(false);

    const added = await this.gitStep('add', ['add', '-A']);
    if (isErr(added)) return added;

    // データ用ブランチはコードではないので、メインのリポジトリのフックを走らせない
    const committed = await this.gitStep('commit', [
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      message,
    ]);
    return isErr(committed) ? committed : ok(true);
  }

  private git(args: readonly string[]): Promise<Result<string, CliError>> {
    return this.runner.run('git', ['-C', this.dataDir, ...args]);
  }

  private async gitStep(
    step: string,
    args: readonly string[]
  ): Promise<Result<string, DataStoreError>> {
    const result = await this.git(args);
    return isErr(result) ? err(gitFailed(step, result.error)) : result;
  }

  private withLock<R, E>(
    task: () => Promise<Result<R, E | DataStoreError>>
  ): Promise<Result<R, E | DataStoreError>> {
    const run = async (): Promise<Result<R, E | DataStoreError>> => {
      const lock = await acquireLock(this.lockPath, this.lockOptions);
      if (isErr(lock)) return lock;

      try {
        return await task();
      } finally {
        releaseLock(this.lockPath, lock.value);
      }
    };

    const queued = this.queue.then(run, run);
    this.queue = queued.catch(() => undefined);
    return queued;
  }
}

function includesOrigin(remotes: string): boolean {
  return remotes.split('\n').some((line) => line.trim() === 'origin');
}

// ============================================================
// ロックファイル
// ============================================================

interface LockContent {
  readonly pid: number;
  readonly token: string;
  readonly at: string;
}

interface LockOptions {
  readonly timeoutMs: number;
  readonly pollMs: number;
  readonly isAlive: (pid: number) => boolean;
}

/**
 * ロックファイルを排他作成で取る。中に pid と時刻を書く。
 *
 * 持ち主の pid が死んでいれば（落ちたプロセスの残骸）、消して取り直す。
 * 中身が読めないものは書きかけの可能性があるので、生きているものとして待つ。
 * 取れたら、放すときに自分のものかを確かめるための札を返す。
 */
async function acquireLock(
  lockPath: string,
  options: LockOptions
): Promise<Result<string, DataStoreError>> {
  const token = randomUUID();
  const content: LockContent = { pid: process.pid, token, at: new Date().toISOString() };
  const deadline = Date.now() + options.timeoutMs;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      fs.writeFileSync(lockPath, `${JSON.stringify(content)}\n`, { flag: 'wx' });
      return ok(token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const holder = readLock(lockPath);
    if (holder !== null && !options.isAlive(holder.pid)) {
      fs.rmSync(lockPath, { force: true });
      continue;
    }

    if (Date.now() >= deadline) return err({ type: 'DataStoreLockTimeout', lockPath });
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
}

/** 中の札が自分のときだけ消す。ほかのプロセスが死んだロックとして取り直したものは消さない */
function releaseLock(lockPath: string, token: string): void {
  if (readLock(lockPath)?.token !== token) return;
  fs.rmSync(lockPath, { force: true });
}

function readLock(lockPath: string): LockContent | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'pid' in parsed &&
      typeof parsed.pid === 'number' &&
      'token' in parsed &&
      typeof parsed.token === 'string'
    ) {
      return { pid: parsed.pid, token: parsed.token, at: 'at' in parsed ? String(parsed.at) : '' };
    }
    return null;
  } catch {
    return null;
  }
}

/** シグナル 0 は届くかだけを確かめる。EPERM は別のユーザのプロセスが生きていることを示す */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ============================================================
// エラーの組み立て
// ============================================================

function gitFailed(step: string, error: CliError): DataStoreError {
  return { type: 'DataStoreGitFailed', step, message: describeCliError(error) };
}

function fetchFailed(error: CliError): DataStoreError {
  return { type: 'DataStoreFetchFailed', message: describeCliError(error) };
}

function pushFailed(attempts: number, error: CliError | null): DataStoreError {
  return {
    type: 'DataStorePushFailed',
    attempts,
    message: error === null ? 'push に失敗した' : describeCliError(error),
  };
}
