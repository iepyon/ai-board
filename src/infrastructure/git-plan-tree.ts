import { err, isErr, ok, type Result } from '../shared/result.js';
import { describeCliError, type CliRunner } from './cli-runner.js';
import { BOARD_DIR, plansLiveInStore, type StoreConfig } from './config.js';
import { gitIn, readBlobs } from './git-objects.js';

// ============================================================
// main の計画ファイルの読み取り — 作業ツリーではなく、置き場所のコミットから読む
// ============================================================

/** コミットの計画ファイル 1 つ */
export interface PlanFileAtCommit {
  /** リポジトリのルートからの相対パス（`.ai-board/cards/<id>/plan.md`） */
  readonly path: string;
  readonly content: string;
  /** そのコミットまでで、このファイルを最後に変えたコミットの時刻（ISO 8601） */
  readonly committedAt: string;
}

/** コードのリポジトリの `planBranch` の先頭を取る専用の参照。ブランチの切り替えやほかの fetch と取り合わない */
export const PLAN_REF = 'refs/ai-board/plan-main';

/**
 * マージ済みの計画を読むコミットを決める。
 *
 * - 置き場所がコードと同じブランチなら、`check()` で取った置き場所の先頭（`storeHead`）
 * - 置き場所が専用のブランチなら、コードのリポジトリ（`store.branchRemote`）の `planBranch` の先頭を fetch して取る
 *
 * fetch や読み取りが失敗しても例外は投げず、警告して null（計画が無いものとして扱う）を返す。
 * 1 回の失敗でボード全体を読めなくしないため。
 */
export async function resolvePlanCommit(options: {
  readonly runner: CliRunner;
  readonly repoDir: string;
  readonly store: StoreConfig;
  readonly storeHead: string | null;
}): Promise<string | null> {
  if (plansLiveInStore(options.store)) return options.storeHead;
  const git = gitIn(options.runner, options.repoDir);
  const { branchRemote, planBranch } = options.store;
  const fetched = await git([
    'fetch',
    '--quiet',
    '--no-tags',
    '--no-write-fetch-head',
    branchRemote,
    `+refs/heads/${planBranch}:${PLAN_REF}`,
  ]);
  const head = isErr(fetched)
    ? fetched
    : await git(['rev-parse', '--verify', `${PLAN_REF}^{commit}`]);
  if (isErr(head)) {
    console.warn(
      `[ai-board] ${branchRemote} の ${planBranch} を取れないため、マージ済みの計画を読み飛ばします: ${describeCliError(head.error)}`
    );
    return null;
  }
  return head.value.trim();
}

/** カードのディレクトリ（`.ai-board/cards`）。カードの置き場所のファイルと計画がここに並ぶ */
export const CARDS_ROOT = `${BOARD_DIR}/cards`;

/** カードの計画ファイルのパス（リポジトリのルートからの相対） */
export function planFilePath(cardId: string): string {
  return `${CARDS_ROOT}/${cardId}/plan.md`;
}

/** 計画ファイルのパス。`<id>` の検査は読む側（計画のリポジトリ）が行う */
export const PLAN_FILE_PATTERN = /^\.ai-board\/cards\/([^/]+)\/plan\.md$/;

const PLAN_GLOB = `:(glob)${CARDS_ROOT}/*/plan.md`;
/** `git log --format` の行の頭の印。ファイルの名前と見分ける */
const COMMIT_MARK = '\u0001';

/**
 * `commit`（置き場所の先頭。`GitDocumentStore.check()` の後の `headCommit()`）の `.ai-board/cards/*\/plan.md` を全部読む。
 *
 * 作業ツリーは読まない。メインのチェックアウトがほかのブランチにいても、そのブランチの計画を main の計画と取り違えないため。
 * 時刻は `git log --first-parent` を 1 回走らせ、ファイルごとに最初に出た（いちばん新しい）コミットの時刻を使う
 * （PR をマージのコミットで入れたときは、ブランチの最後のコミットではなく、main に入ったマージの時刻になる）。
 * `commit` が null（置き場所のブランチがまだ無い）なら空を返す。
 */
export async function readPlanFilesAtCommit(options: {
  readonly runner: CliRunner;
  readonly repoDir: string;
  readonly commit: string | null;
}): Promise<Result<readonly PlanFileAtCommit[], string>> {
  if (options.commit === null) return ok([]);
  const git = gitIn(options.runner, options.repoDir);

  const [files, log] = await Promise.all([
    readBlobs(git, options.commit, [CARDS_ROOT], (filePath) => PLAN_FILE_PATTERN.test(filePath)),
    // main をたどり、マージのコミットは 1 つ目の親との差分でファイルを出す（計画が main に入った時刻を使う）
    git([
      'log',
      '--first-parent',
      '--diff-merges=first-parent',
      `--format=${COMMIT_MARK}%cI`,
      '--name-only',
      options.commit,
      '--',
      PLAN_GLOB,
    ]),
  ]);
  if (isErr(files))
    return err(`計画を読めません（${files.error.operation}）: ${files.error.message}`);
  if (files.value.length === 0) return ok([]);
  if (isErr(log)) return err('計画の履歴を読めません');

  const times = latestCommitTimes(log.value);
  return ok(
    files.value.flatMap((file) => {
      const committedAt = times.get(file.path);
      return committedAt === undefined ? [] : [{ ...file, committedAt }];
    })
  );
}

/** `git log --format=<印>%cI --name-only` の出力から、ファイルごとのいちばん新しいコミットの時刻を引く */
export function latestCommitTimes(output: string): Map<string, string> {
  const times = new Map<string, string>();
  let current: string | null = null;
  for (const line of output.split('\n')) {
    if (line.startsWith(COMMIT_MARK)) {
      current = new Date(line.slice(COMMIT_MARK.length).trim()).toISOString();
    } else if (line !== '' && current !== null && !times.has(line)) {
      times.set(line, current);
    }
  }
  return times;
}
