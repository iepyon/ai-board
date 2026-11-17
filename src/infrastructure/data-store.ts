import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SNAPSHOTS_DIR } from '../board/repositories/file-pr-snapshot.repository.js';
import { LOOP_DIR } from '../board/repositories/loop-history.repository.js';
import {
  CARDS_DIR,
  DATA_VERSION_FILE,
  ORDER_FILE,
  parseDataVersion,
  type DataVersionError,
} from '../cards/repositories/card-files.js';
import { CONFIG_FILE, type DataMode } from './config.js';
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

/**
 * データ用ブランチに載せるパス（データのワークツリーからの相対）。
 *
 * 人のグローバルの gitignore（`core.excludesFile`）やメインのリポジトリの `.git/info/exclude` に
 * `log/` などがあっても、ここに置いたファイルは無視させずにコミットし、捨てるときも消す。
 */
const DATA_PATHS = [
  CARDS_DIR,
  ORDER_FILE,
  SNAPSHOTS_DIR,
  LOOP_DIR,
  DATA_VERSION_FILE,
  CONFIG_FILE,
] as const;

/**
 * データのワークツリーを触る git の呼び出しに付ける設定。
 *
 * Windows の Git の既定（`core.autocrlf=true`）では、取り出したカードのファイルが CRLF になる。
 * データ用ブランチは別のブランチなのでメインの `.gitattributes` が効かず、データ用ブランチに
 * `.gitattributes` を足すと形が変わる。CLI は LF で書くので、ここで変換を止めて LF のまま取り出す。
 * 人の `core.attributesFile` やシステムの gitattributes に `* text=auto` などがあるとその属性が効くので、
 * そのときも取り出しの改行が LF になるよう `core.eol=lf` も付ける（既定の `native` は Windows で CRLF）。
 */
export const DATA_GIT_CONFIG = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'] as const;

/** `dir` で git を走らせる。改行コードの変換を止める設定を必ず付ける */
function runGit(
  runner: CliRunner,
  dir: string,
  args: readonly string[]
): Promise<Result<string, CliError>> {
  return runner.run('git', ['-C', dir, ...DATA_GIT_CONFIG, ...args]);
}

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
  /**
   * データのワークツリーの HEAD が、データ用ブランチでもコミットの無いブランチでもない
   * （`AI_BOARD_DATA` がコードの clone を指しているなど）。`branch` は HEAD の指す ref で、ブランチを指していなければ null
   */
  | {
      readonly type: 'DataDirWrongBranch';
      readonly dataDir: string;
      readonly branch: string | null;
    }
  /** ほかのプロセスがロックを持ったまま、待つ上限を過ぎた */
  | { readonly type: 'DataStoreLockTimeout'; readonly lockPath: string }
  /** 書き込みの前の取り直しで fetch に失敗した（オフラインなど）。push できないので書けない */
  | { readonly type: 'DataStoreFetchFailed'; readonly message: string }
  /** push に失敗した（ネットワーク、拒否が上限まで続いた） */
  | { readonly type: 'DataStorePushFailed'; readonly attempts: number; readonly message: string }
  /** fetch / push 以外の git の操作に失敗した */
  | { readonly type: 'DataStoreGitFailed'; readonly step: string; readonly message: string }
  /**
   * 既定のモードで、`origin` のデータ用ブランチに無いコミットが手元の `HEAD` にある（手元モードで書いたものなど）。
   * 取り直しの `reset --hard` で黙って消さないよう、読み書きの前に止まる
   */
  | { readonly type: 'DataStoreLocalAhead'; readonly dataDir: string; readonly count: number }
  /**
   * 取り直した `ai-board-data.yaml` の版が、この CLI の版と違う（`UnsupportedDataVersion`）か読めない（`MalformedDataVersion`）。
   * 違う形を今の形として読み書きしないよう、中身を読まずに止まる
   */
  | DataVersionError;

/** 取り直しの結果 */
export type RefreshOutcome =
  /** `origin` の最新に合わせた */
  | { readonly kind: 'fetched' }
  /** `origin` が無い（テスト用など）。手元のコミットに合わせた */
  | { readonly kind: 'no-origin' }
  /** 手元モード。`origin` に触れず、手元のコミットに合わせた */
  | { readonly kind: 'local' }
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
  /**
   * 読み書きのモード。既定は `sync`。
   *
   * - `sync`: 読み書きのたびに `origin` から取り直し、書いたら push する
   * - `local`: `origin` に触れず、手元のコミットだけで読み書きする（GitHub に届かない研修の環境向け）
   */
  readonly mode?: DataMode;
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
  private readonly mode: DataMode;
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
    this.mode = options.mode ?? 'sync';
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
    if (isErr(committed)) {
      // 書きかけのファイルを残すと、次の取り直しまで記録されていない書き込みを読ませてしまう
      await this.discardTo('HEAD');
      return done(committed);
    }
    if (!committed.value || base.value === null) return done(written);

    const pushed = await pushData(this.runner, this.dataDir);
    if (isErr(pushed)) {
      // 拒否されたコミットを手元に残さない。次の取り直しの守りが、手元モードのコミットと取り違えないように
      await this.discardTo(base.value);
      return { kind: 'rejected', base: base.value, error: pushed.error };
    }
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
    if (outcome.kind === 'no-origin' || outcome.kind === 'local') return ok(null);
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
      runGit(this.runner, repoRoot, args);

    const usesOrigin = await this.usesOrigin(repoRoot);
    if (isErr(usesOrigin)) return usesOrigin;
    const withOrigin = usesOrigin.value;

    if (withOrigin) {
      // fetch の失敗は「ブランチが無い」と「ネットワーク」を分けられないので、先に有無を問う
      const heads = await inRepo(['ls-remote', '--heads', 'origin', DATA_BRANCH]);
      if (isErr(heads)) return err(fetchFailed(heads.error));
      if (heads.value.trim() === '') return err({ type: 'DataBranchMissing', dataDir });

      const fetched = await inRepo(['fetch', '--quiet', 'origin', DATA_FETCH_REFSPEC]);
      if (isErr(fetched)) return err(fetchFailed(fetched.error));
    }

    const local = await inRepo(['rev-parse', '--verify', '--quiet', `refs/heads/${DATA_BRANCH}`]);
    if (isErr(local) && !withOrigin && !(await this.trackedBranchUsable(repoRoot))) {
      return err({ type: 'DataBranchMissing', dataDir });
    }

    // 人がデータのワークツリーを消すと登録だけが残り、worktree add が
    // 「missing but already registered worktree」で拒む。消えたワークツリーの登録を先に片付ける
    const pruned = await inRepo(['worktree', 'prune']);
    if (isErr(pruned)) return err(gitFailed('worktree prune', pruned.error));

    const args = isErr(local)
      ? ['worktree', 'add', '--quiet', '-b', DATA_BRANCH, dataDir, DATA_REMOTE_REF]
      : ['worktree', 'add', '--quiet', dataDir, DATA_BRANCH];
    const added = await inRepo(args);
    return isErr(added) ? err(gitFailed('worktree add', added.error)) : ok(undefined);
  }

  /** 手元モードで、最後に取った origin のデータ用ブランチ（追跡のブランチ）からワークツリーを作れるか */
  private async trackedBranchUsable(repoRoot: string): Promise<boolean> {
    if (this.mode !== 'local') return false;
    const tracked = await runGit(this.runner, repoRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      DATA_REMOTE_REF,
    ]);
    return !isErr(tracked);
  }

  /**
   * `dir` のリポジトリで `origin` に問い合わせるか。手元モードでは `git remote` も走らせずに問い合わせない
   */
  private async usesOrigin(dir: string): Promise<Result<boolean, DataStoreError>> {
    if (this.mode === 'local') return ok(false);
    const remotes = await runGit(this.runner, dir, ['remote']);
    return isErr(remotes)
      ? err(gitFailed('remote', remotes.error))
      : ok(includesOrigin(remotes.value));
  }

  /**
   * fetch して `origin` の最新に合わせる。fetch に失敗したら、最後に知っている `origin` の内容に合わせる。
   * 手元モードと `origin` の無いワークツリーでは、fetch せずに手元の `HEAD` に合わせる。
   *
   * 既定のモードでは、合わせる前に `origin` に無いコミットが手元にあるかを数え、あれば止まる（`guardLocalAhead`）。
   * 手元モードで書いたコミットを、既定のモードに戻した最初の取り直しで黙って捨てないためである。
   *
   * 合わせた後に形の版を確かめる。`refresh` と `transact`（`op` の前）はどちらもここを通るので、
   * この CLI と違う版のデータは、読み出しでも書き込みでも中身に触れる前に止まる。
   */
  private async sync(): Promise<Result<RefreshOutcome, DataStoreError>> {
    const useOrigin = await this.usesOrigin(this.dataDir);
    if (isErr(useOrigin)) return useOrigin;

    // reset と clean はブランチを動かし、追跡していないファイルを消す。データ用ブランチの上でしか走らせない
    const onDataBranch = await this.ensureDataBranchHead();
    if (isErr(onDataBranch)) return onDataBranch;

    if (!useOrigin.value) {
      const discarded = await this.discardTo('HEAD');
      if (isErr(discarded)) return discarded;
      return this.checkVersion({ kind: this.mode === 'local' ? 'local' : 'no-origin' });
    }

    const fetched = await this.git(['fetch', '--quiet', 'origin', DATA_FETCH_REFSPEC]);
    const guarded = await this.guardLocalAhead();
    if (isErr(guarded)) return guarded;
    const discarded = await this.discardTo(DATA_REMOTE_REF);
    if (isErr(discarded)) return discarded;

    return this.checkVersion(
      isErr(fetched)
        ? { kind: 'offline', reason: describeCliError(fetched.error) }
        : { kind: 'fetched' }
    );
  }

  /**
   * `origin` のデータ用ブランチに無いコミットが手元の `HEAD` にあれば、`DataStoreLocalAhead` で止まる。
   *
   * 追跡のブランチがまだ無い、まだコミットの無いブランチ（データ用ブランチしか無い `origin` の clone）では
   * `rev-list` が失敗する。比べる先か先のコミットが無いので数えない（続く `reset --hard` が今どおり扱う）。
   */
  private async guardLocalAhead(): Promise<Result<void, DataStoreError>> {
    const counted = await this.git(['rev-list', '--count', `${DATA_REMOTE_REF}..HEAD`]);
    if (isErr(counted)) return ok(undefined);

    const count = Number.parseInt(counted.value.trim(), 10);
    return count > 0
      ? err({ type: 'DataStoreLocalAhead', dataDir: this.dataDir, count })
      : ok(undefined);
  }

  /**
   * HEAD がデータ用ブランチを指しているかを確かめる。
   *
   * - データ用ブランチ: そのまま
   * - まだコミットの無いブランチ（データ用ブランチしか無い `origin` の clone）: HEAD をデータ用ブランチへ向け直す
   * - それ以外（コードの clone の `main`、detached など）: 何も変えずに止まる。
   *   続く `reset --hard` がそのブランチをデータのコミットへ動かし、`clean` が追跡していないファイルを消してしまう
   */
  private async ensureDataBranchHead(): Promise<Result<void, DataStoreError>> {
    const dataRef = `refs/heads/${DATA_BRANCH}`;
    const head = await this.git(['symbolic-ref', '--quiet', 'HEAD']);
    if (isErr(head))
      return err({ type: 'DataDirWrongBranch', dataDir: this.dataDir, branch: null });

    const branch = head.value.trim();
    if (branch === dataRef) return ok(undefined);

    const born = await this.git(['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (!isErr(born)) return err({ type: 'DataDirWrongBranch', dataDir: this.dataDir, branch });

    const pointed = await this.gitStep('symbolic-ref', ['symbolic-ref', 'HEAD', dataRef]);
    return isErr(pointed) ? pointed : ok(undefined);
  }

  /**
   * `ai-board-data.yaml` の版が、この CLI が読み書きできる版かを確かめる。
   *
   * ファイルが無ければ確かめない（`init` は必ず書くので、無いのは版を持たない試しのデータだけである）。
   */
  private checkVersion(outcome: RefreshOutcome): Result<RefreshOutcome, DataStoreError> {
    const raw = readFileOrNull(path.join(this.dataDir, DATA_VERSION_FILE));
    if (raw === null) return ok(outcome);

    const version = parseDataVersion(raw);
    return isErr(version) ? version : ok(outcome);
  }

  /**
   * 手元の変更を捨てて、`target` に合わせる。
   *
   * `reset --hard` は追跡していないファイルを残し、次の `commit` が拾ってしまうので `clean` も走らせる。
   * `commit` は `DATA_PATHS` の下の無視されるファイルも足すので、そこは `-x` で無視されるファイルまで消す
   * （残すと、拒んだ書き込みの判断のファイルが次の書き込みのコミットに混ざる）。
   * 手元にしか無い変更は持たない前提なので、捨ててよい。
   */
  private async discardTo(target: string): Promise<Result<void, DataStoreError>> {
    const reset = await this.gitStep('reset', ['reset', '--hard', '--quiet', target]);
    if (isErr(reset)) return reset;
    const cleaned = await this.gitStep('clean', ['clean', '-fdq']);
    if (isErr(cleaned)) return cleaned;
    const ignored = await this.gitStep('clean', ['clean', '-fdqx', '--', ...DATA_PATHS]);
    return isErr(ignored) ? ignored : ok(undefined);
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

  /**
   * 変化があればコミットする。コミットしたかを返す。
   *
   * `git add -A` は人の無視の設定に従い、`log/` などが無視されると判断のファイルをコミットしない。
   * `DATA_PATHS` のうち手元にあるものを `--force` で足し、消えた追跡済みのファイルは `--update` で足す。
   * コミットするかは、無視されたファイルも数えるよう、足した後のインデックスで決める。
   */
  private async commit(message: string): Promise<Result<boolean, DataStoreError>> {
    // 手元にも追跡にも無いパスを渡すと git add が失敗するので、手元にあるものだけを渡す
    const present = DATA_PATHS.filter((p) => fs.existsSync(path.join(this.dataDir, p)));
    if (present.length > 0) {
      const added = await this.gitStep('add', ['add', '--all', '--force', '--', ...present]);
      if (isErr(added)) return added;
    }
    const updated = await this.gitStep('add', ['add', '--update']);
    if (isErr(updated)) return updated;

    const staged = await this.gitStep('diff', ['diff', '--cached', '--name-only']);
    if (isErr(staged)) return staged;
    if (staged.value.trim() === '') return ok(false);

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
    return runGit(this.runner, this.dataDir, args);
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

/**
 * データ用ブランチを `origin` へ push し、通ったら追跡のブランチを進める。
 *
 * fetch の refspec が ai-board/data を写さない clone では、push しても追跡のブランチが動かない。
 * 次の取り直しで fetch に失敗したとき、上げ済みのコミットを守りが「origin に無い」と数えないよう進めておく。
 * 書き込みは push で済んでいるので、追跡のブランチを進めるのが失敗しても失敗にしない（次の fetch が直す）
 */
async function pushData(runner: CliRunner, dataDir: string): Promise<Result<string, CliError>> {
  const pushed = await runGit(runner, dataDir, [
    'push',
    '--quiet',
    '--no-verify',
    'origin',
    DATA_PUSH_REFSPEC,
  ]);
  if (!isErr(pushed)) await runGit(runner, dataDir, ['update-ref', DATA_REMOTE_REF, 'HEAD']);
  return pushed;
}

function includesOrigin(remotes: string): boolean {
  return remotes.split('\n').some((line) => line.trim() === 'origin');
}

// ============================================================
// データ用ブランチを作る — `ai-board init`
// ============================================================

/** データ用ブランチを作れなかった理由 */
export type DataBranchCreateError =
  /** データ用ブランチが `origin` か手元に既にある */
  | { readonly type: 'DataBranchExists'; readonly where: 'origin' | 'local' }
  /** データのワークツリーの場所に、既にファイルがある */
  | { readonly type: 'DataDirNotEmpty'; readonly dataDir: string }
  | DataStoreError;

export interface CreateDataBranchOptions {
  /** データのワークツリー */
  readonly dataDir: string;
  /**
   * データのワークツリーを `git worktree add` で作るリポジトリ（既定の置き場所のとき）。
   * 無ければ（`AI_BOARD_DATA`）、`dataDir` を用意済みの空の clone として使う
   */
  readonly repoRoot?: string;
  readonly runner: CliRunner;
}

/** データ用ブランチをどこに作るか */
interface DataBranchTarget {
  /** `worktree` は `repoRoot` から新しく作る。`clone` は `dataDir` の空の clone をそのまま使う */
  readonly kind: 'worktree' | 'clone';
  /** git を走らせるリポジトリ */
  readonly repo: string;
  readonly withOrigin: boolean;
}

/**
 * データ用ブランチを作る前に確かめる。作ってよければ、どこに作るかを返す。
 *
 * - 既定の置き場所（`repoRoot` あり）: `dataDir` が無いか空であること
 * - `AI_BOARD_DATA`（`repoRoot` なし）: `dataDir` が `.git` の他に何も無い clone であること。
 *   ほかのファイルがあると、それがデータ用ブランチに入ってしまう
 * - `origin` にも手元にも、データ用ブランチが無いこと。`origin` に問い合わせられなければ（オフライン）止まる
 */
async function checkDataBranchAbsent(
  options: CreateDataBranchOptions
): Promise<Result<DataBranchTarget, DataBranchCreateError>> {
  const location = dataBranchLocation(options);
  if (isErr(location)) return location;

  const { kind, repo } = location.value;
  const inRepo = (args: readonly string[]): Promise<Result<string, CliError>> =>
    runGit(options.runner, repo, args);

  const remotes = await inRepo(['remote']);
  if (isErr(remotes)) return err(gitFailed('remote', remotes.error));
  const withOrigin = includesOrigin(remotes.value);

  if (withOrigin) {
    const heads = await inRepo(['ls-remote', '--heads', 'origin', DATA_BRANCH]);
    if (isErr(heads)) return err(fetchFailed(heads.error));
    if (heads.value.trim() !== '') return err({ type: 'DataBranchExists', where: 'origin' });
  }

  const local = await inRepo(['rev-parse', '--verify', '--quiet', `refs/heads/${DATA_BRANCH}`]);
  if (!isErr(local)) return err({ type: 'DataBranchExists', where: 'local' });

  return ok({ kind, repo, withOrigin });
}

/** データ用ブランチをどのリポジトリに作るか。`dataDir` の中身で決め、使えなければ失敗する */
function dataBranchLocation(
  options: CreateDataBranchOptions
): Result<Pick<DataBranchTarget, 'kind' | 'repo'>, DataBranchCreateError> {
  const dataDir = path.resolve(options.dataDir);
  const entries = fs.existsSync(dataDir) ? fs.readdirSync(dataDir) : null;

  if (options.repoRoot !== undefined) {
    if (entries !== null && entries.length > 0) return err({ type: 'DataDirNotEmpty', dataDir });
    return ok({ kind: 'worktree', repo: path.resolve(options.repoRoot) });
  }

  if (entries === null || !entries.includes('.git')) {
    return err({ type: 'DataDirNotRepository', dataDir });
  }
  if (entries.length > 1) return err({ type: 'DataDirNotEmpty', dataDir });
  return ok({ kind: 'clone', repo: dataDir });
}

/**
 * データ用ブランチを、親を持たないブランチとして作り、`write` が書いたファイルを 1 コミットにして push する。
 *
 * 既定の置き場所では、`repoRoot` から中身を展開しないワークツリーを足し、HEAD をまだ無いデータ用ブランチへ向け、
 * インデックスを空にしてから書く（`git worktree add --orphan` を持たない古い git でも動くように）。
 * `origin` が無ければ（テスト用）、push せずにコミットだけする。
 *
 * どこかで失敗したら、作ったワークツリー・ブランチ・書いたファイルを片付けてから失敗を返す。
 * 片付けないと、次の `ai-board card` が案内（`ai-board init` を走らせる）ではなく git の失敗で止まり、
 * `init` のやり直しも「既にある」で拒まれる。
 */
export async function createDataBranch(
  options: CreateDataBranchOptions,
  message: string,
  write: (dataDir: string) => void
): Promise<Result<{ readonly pushed: boolean }, DataBranchCreateError>> {
  const checked = await checkDataBranchAbsent(options);
  if (isErr(checked)) return checked;

  const target = checked.value;
  const dataDir = path.resolve(options.dataDir);
  const inData = (args: readonly string[]): Promise<Result<string, CliError>> =>
    runGit(options.runner, dataDir, args);

  const steps: readonly (readonly [string, () => Promise<Result<string, CliError>>])[] = [
    ...(target.kind === 'worktree'
      ? [
          [
            'worktree add',
            () =>
              runGit(options.runner, target.repo, [
                'worktree',
                'add',
                '--quiet',
                '--detach',
                '--no-checkout',
                dataDir,
              ]),
          ] as const,
        ]
      : []),
    ['symbolic-ref', () => inData(['symbolic-ref', 'HEAD', `refs/heads/${DATA_BRANCH}`])],
    ['read-tree', () => inData(['read-tree', '--empty'])],
  ];

  for (const [step, run] of steps) {
    const result = await run();
    if (isErr(result)) {
      await rollbackDataBranch(options.runner, target, dataDir);
      return err(gitFailed(step, result.error));
    }
  }

  try {
    write(dataDir);
  } catch (error) {
    await rollbackDataBranch(options.runner, target, dataDir);
    throw error;
  }

  const committing: readonly (readonly [string, readonly string[]])[] = [
    ['add', ['add', '-A']],
    // データ用ブランチはコードではないので、メインのリポジトリのフックを走らせない
    ['commit', ['commit', '--quiet', '--no-verify', '-m', message]],
  ];
  for (const [step, args] of committing) {
    const result = await inData(args);
    if (isErr(result)) {
      await rollbackDataBranch(options.runner, target, dataDir);
      return err(gitFailed(step, result.error));
    }
  }

  if (!target.withOrigin) return ok({ pushed: false });

  const pushed = await pushData(options.runner, dataDir);
  if (isErr(pushed)) {
    await rollbackDataBranch(options.runner, target, dataDir);
    return err(pushFailed(1, pushed.error));
  }

  return ok({ pushed: true });
}

/** `createDataBranch` が作ったものを片付ける。片付けの失敗は、元の失敗を隠さないよう黙って見送る */
async function rollbackDataBranch(
  runner: CliRunner,
  target: DataBranchTarget,
  dataDir: string
): Promise<void> {
  const inRepo = (args: readonly string[]): Promise<Result<string, CliError>> =>
    runGit(runner, target.repo, args);

  if (target.kind === 'worktree') {
    const removed = await inRepo(['worktree', 'remove', '--force', dataDir]);
    if (isErr(removed)) {
      fs.rmSync(dataDir, { recursive: true, force: true });
      await inRepo(['worktree', 'prune']);
    }
    await inRepo(['branch', '--quiet', '-D', DATA_BRANCH]);
    return;
  }

  // 用意済みの clone は残し、作ったブランチと書いたファイルだけを消す（確かめたとおり、元は .git だけだった）
  await inRepo(['update-ref', '-d', `refs/heads/${DATA_BRANCH}`]);
  await inRepo(['read-tree', '--empty']);
  await inRepo(['clean', '-fdxq']);
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

function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
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
