import { isErr, type Result } from '../../shared/result.js';
import type { StoreError } from '../../infrastructure/document-store.js';
import type { BranchCheckError } from '../../infrastructure/git-branch-check.js';
import { describeStoreError } from '../../infrastructure/store-messages.js';

// ============================================================
// ai-board store — git の置き場所を始める・seed を入れる・カードのブランチを検査する
// ============================================================

/**
 * カードの置き場所は、git の置き場所のブランチ（既定は `origin` の `main`）の `.ai-board/` のファイルにある。
 * カードの読み書きは `ai-board card` / `decide` が直接 push するので、ここには置き場所そのものの準備と検査だけを置く。
 *
 * - `init`: 空の置き場所に最初の文書（`board.yaml` と空の並び順）を書く
 * - `seed`: seed のファイルから、まだ無いカードを起票する（`ai-board card seed` と同じ）
 * - `check-branch`: カードのブランチが置き場所のファイルを変えていないかを確かめる。ループは push の前に走らせる
 *
 * カードの書き込みの口（AI に許す usecase）はここに無い。
 */
export const STORE_USAGE = `使い方: ai-board store <command> [--root <path>]

カードの置き場所（git の置き場所のブランチの .ai-board/）を始め、カードのブランチを検査する。

Commands:
  init                  空の置き場所に最初の文書（.ai-board/board.yaml と order.yaml）を書いて push する
  seed [--from <dir>]   seed のファイル（既定は .ai-board/seed/）から、まだ無いカードを起票する
                        （ai-board card seed と同じ）
  check-branch <branch> 置き場所のブランチとの分岐点から <branch> までに、置き場所のファイル
                        （board.yaml・order.yaml・cards/<id>/card.md・cards/<id>/log/）の変更があれば
                        並べて 1 で終わる（計画 cards/<id>/plan.md の変更は通す）
`;

export interface StoreCliDependencies {
  /** 置き場所を始める。既にあれば `StoreAlreadyInitialized` */
  readonly initialize: () => Promise<Result<void, StoreError>>;
  /** `seed` を `ai-board card seed --from <dir>` に渡す */
  readonly runSeed: (dir: string) => Promise<number>;
  /** `seed` の既定のディレクトリ */
  readonly seedDir: string;
  /** 置き場所を読み込んでから、`branch` が変えた置き場所のファイルを返す */
  readonly checkBranch: (
    branch: string
  ) => Promise<Result<readonly string[], StoreError | BranchCheckError>>;
}

export interface StoreCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const COMMANDS = ['init', 'seed', 'check-branch'] as const;
type StoreCommand = (typeof COMMANDS)[number];

export function isStoreCommand(value: string | undefined): value is StoreCommand {
  return value !== undefined && (COMMANDS as readonly string[]).includes(value);
}

function isHelp(command: string | undefined, rest: readonly string[]): boolean {
  return (
    command === undefined ||
    command === '--help' ||
    command === '-h' ||
    rest.includes('--help') ||
    rest.includes('-h')
  );
}

export async function runStoreCli(
  argv: readonly string[],
  deps: StoreCliDependencies,
  io: StoreCliIo
): Promise<number> {
  const [command, ...rest] = argv;
  if (isHelp(command, rest)) {
    io.stderr(STORE_USAGE);
    return 0;
  }
  if (!isStoreCommand(command)) {
    io.stderr(`不明なコマンドです: ${String(command)}\n${STORE_USAGE}`);
    return 1;
  }

  switch (command) {
    case 'init':
      return rest.length > 0 ? fail(io, `不明な引数です: ${rest.join(' ')}`) : runInit(deps, io);
    case 'seed':
      return runSeed(rest, deps, io);
    case 'check-branch':
      return runCheckBranch(rest, deps, io);
  }
}

async function runInit(deps: StoreCliDependencies, io: StoreCliIo): Promise<number> {
  const result = await deps.initialize();
  if (isErr(result)) return fail(io, describeStoreError(result.error));
  io.stdout('置き場所を始めました（.ai-board/board.yaml と order.yaml を push しました）\n');
  return 0;
}

function runSeed(
  rest: readonly string[],
  deps: StoreCliDependencies,
  io: StoreCliIo
): Promise<number> {
  if (rest.length === 0) return deps.runSeed(deps.seedDir);
  const [flag, value, ...extra] = rest;
  if (flag !== '--from' || value === undefined || value.startsWith('--') || extra.length > 0) {
    return Promise.resolve(fail(io, '--from には seed のディレクトリを指定してください'));
  }
  return deps.runSeed(value);
}

async function runCheckBranch(
  rest: readonly string[],
  deps: StoreCliDependencies,
  io: StoreCliIo
): Promise<number> {
  const [branch, ...extra] = rest;
  if (branch === undefined || branch.startsWith('-') || extra.length > 0) {
    return fail(io, 'check-branch には検査するブランチを 1 つ指定してください');
  }

  const result = await deps.checkBranch(branch);
  if (isErr(result)) return fail(io, describeCheckError(result.error));
  if (result.value.length > 0) {
    return fail(
      io,
      `${branch} が置き場所のファイルを変えています。カードの書き込みは ai-board card / decide で行い、` +
        `ブランチではこれらのファイルを変えないでください:\n${result.value.map((name) => `  ${name}`).join('\n')}`
    );
  }
  io.stdout(`${branch} は置き場所のファイルを変えていません\n`);
  return 0;
}

function describeCheckError(error: StoreError | BranchCheckError): string {
  switch (error.type) {
    case 'BranchNotFound':
      return `ブランチ ${error.branch} が見つかりません`;
    case 'StoreNotFetched':
      return '置き場所のブランチがまだありません。ai-board store init を走らせてください';
    case 'BranchCheckFailed':
      return `ブランチの差分を読めませんでした: ${error.message}`;
    default:
      return describeStoreError(error);
  }
}

function fail(io: StoreCliIo, message: string): number {
  io.stderr(`${message}\n`);
  return 1;
}
