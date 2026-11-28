import { isErr, type Result } from '../../shared/result.js';
import type { StoreError } from '../../infrastructure/document-store.js';
import { describeStoreError } from '../../infrastructure/store-messages.js';

// ============================================================
// ai-board store — カードの置き場所（Issue）を始める・seed を入れる
// ============================================================

/**
 * カードの置き場所は、リポジトリの GitHub Issue にある（ADR 0021）。
 * カードの読み書きは `ai-board card` / `decide` が直接 Issue に書くので、ここには置き場所そのものの準備だけを置く。
 *
 * - `init`: 置き場所の Issue（形の版と空の並び順）を作る
 * - `seed`: seed のファイルから、まだ無いカードを Issue に起票する（`ai-board card seed` と同じ）
 *
 * カードの書き込みの口（AI に許す usecase）はここに無い。
 */
export const STORE_USAGE = `使い方: ai-board store <command> [--root <path>]

カードの置き場所（リポジトリの GitHub Issue）を始め、最初のカードを入れる。

Commands:
  init                  置き場所の Issue（形の版と空の並び順）を作る。.ai-board/config.yaml の github.repository を使う
  seed [--from <dir>]   seed のファイル（既定は .ai-board/seed/）から、まだ無いカードを Issue に起票する
                        （ai-board card seed と同じ）

AI_BOARD_STORE にディレクトリを指すと、GitHub に何も書かずに、そのディレクトリで試せる。
`;

export interface StoreCliDependencies {
  /** 置き場所を始める。既にあれば `StoreAlreadyInitialized` */
  readonly initialize: () => Promise<Result<void, StoreError>>;
  /** `seed` を `ai-board card seed --from <dir>` に渡す */
  readonly runSeed: (dir: string) => Promise<number>;
  /** `seed` の既定のディレクトリ */
  readonly seedDir: string;
}

export interface StoreCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const COMMANDS = ['init', 'seed'] as const;
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
  }
}

async function runInit(deps: StoreCliDependencies, io: StoreCliIo): Promise<number> {
  const result = await deps.initialize();
  if (isErr(result)) return fail(io, describeStoreError(result.error));
  io.stdout('置き場所を始めました（置き場所の Issue を作りました）\n');
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

function fail(io: StoreCliIo, message: string): number {
  io.stderr(`${message}\n`);
  return 1;
}
