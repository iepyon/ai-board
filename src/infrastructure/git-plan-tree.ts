import { err, isErr, ok, type Result } from '../shared/result.js';
import type { CliRunner } from './cli-runner.js';
import { parseCatFileBatch } from './git-document-store.js';

// ============================================================
// 参照の計画ファイルの読み取り — 作業ツリーではなく、git の参照から読む
// ============================================================

/** 参照の計画ファイル 1 つ */
export interface PlanFileAtRef {
  /** リポジトリのルートからの相対パス（`.ai-board/cards/<id>/plan.md`） */
  readonly path: string;
  readonly content: string;
  /** その参照で、このファイルを最後に変えたコミットの時刻（ISO 8601） */
  readonly committedAt: string;
}

/** 計画ファイルのパス。`<id>` の検査は読む側（計画のリポジトリ）が行う */
export const PLAN_FILE_PATTERN = /^\.ai-board\/cards\/([^/]+)\/plan\.md$/;

const CARDS_ROOT = '.ai-board/cards';
const PLAN_GLOB = `:(glob)${CARDS_ROOT}/*/plan.md`;
/** `git log --format` の行の頭の印。ファイルの名前と見分ける */
const COMMIT_MARK = '\u0001';

/**
 * `ref` の `.ai-board/cards/*\/plan.md` を全部読む。
 *
 * 作業ツリーは読まない。メインのチェックアウトがほかのブランチにいても、そのブランチの計画を main の計画と取り違えないため。
 * 時刻は `git log` を 1 回走らせ、ファイルごとに最初に出た（いちばん新しい）コミットの時刻を使う。
 * `ref` が無ければ（置き場所のブランチがまだ無い）空を返す。
 */
export async function readPlanFilesAtRef(options: {
  readonly runner: CliRunner;
  readonly repoDir: string;
  readonly ref: string;
}): Promise<Result<readonly PlanFileAtRef[], string>> {
  const git = (args: readonly string[], input?: string): ReturnType<CliRunner['run']> =>
    options.runner.run(
      'git',
      ['-C', options.repoDir, ...args],
      input === undefined ? {} : { input }
    );

  const exists = await git(['rev-parse', '--verify', '--quiet', `${options.ref}^{commit}`]);
  if (isErr(exists)) return ok([]);

  const listed = await git(['ls-tree', '-r', '-z', options.ref, '--', CARDS_ROOT]);
  if (isErr(listed)) return err(`計画を並べられません: ${messageOf(listed.error)}`);
  const entries = listed.value
    .split('\0')
    .filter((line) => line !== '')
    .flatMap((line) => {
      const tab = line.indexOf('\t');
      const [, type, object] = line.slice(0, tab).split(' ');
      const filePath = line.slice(tab + 1);
      return type === 'blob' && object !== undefined && PLAN_FILE_PATTERN.test(filePath)
        ? [{ object, path: filePath }]
        : [];
    });
  if (entries.length === 0) return ok([]);

  const [read, log] = await Promise.all([
    git(['cat-file', '--batch'], entries.map((entry) => `${entry.object}\n`).join('')),
    git(['log', `--format=${COMMIT_MARK}%cI`, '--name-only', options.ref, '--', PLAN_GLOB]),
  ]);
  if (isErr(read)) return err(`計画を読めません: ${messageOf(read.error)}`);
  if (isErr(log)) return err(`計画の履歴を読めません: ${messageOf(log.error)}`);

  const contents = parseCatFileBatch(read.value);
  const times = latestCommitTimes(log.value);
  return ok(
    entries.flatMap((entry, i) => {
      const committedAt = times.get(entry.path);
      const content = contents[i];
      return committedAt === undefined || content === undefined
        ? []
        : [{ path: entry.path, content, committedAt }];
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

function messageOf(error: { readonly type: string }): string {
  return 'message' in error && typeof error.message === 'string' ? error.message : error.type;
}
