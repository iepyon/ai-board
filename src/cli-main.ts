import * as fs from 'node:fs';
import * as path from 'node:path';
import { startServer, DEFAULT_PORT } from './server.js';
import {
  BOARD_DIR,
  CONFIG_FILE,
  DATA_ENV,
  legacyDbPath,
  loadConfig,
  resolvePaths,
  type AppConfig,
  type BoardPaths,
} from './shared/config.js';
import { readLegacyBoard } from './infrastructure/database.js';
import { createCliRunner } from './infrastructure/cli-runner.js';
import {
  createBoardDataStore,
  createFileCardDependencies,
  createTransactionalMrWriter,
} from './cards/composition.js';
import { runCardCli, type CardCliIo } from './cards/cli/card-cli.js';
import { runMigrateCli } from './cards/cli/migrate-cli.js';
import { describeDataStoreError, describeOfflineRead } from './cards/cli/data-store-messages.js';
import {
  createBoardDependencies,
  createLoopHistoryRepository,
  createBranchPlanRepository,
  createFileMrSnapshotRepository,
  createMrStateSource,
} from './board/composition.js';
import { parseStatusArgs, runStatusCli, STATUS_USAGE } from './board/cli/status-cli.js';
import { isPrCommand, runPrCli } from './board/cli/pr-cli.js';
import { runLoopCli } from './board/cli/loop-cli.js';
import { findLiveServer } from './infrastructure/server-info.js';
import { openBrowser } from './infrastructure/open-browser.js';
import { writePidFile } from './infrastructure/pid-file.js';
import { isErr } from './shared/result.js';
import { CardIdSchema, type CardId } from './shared/schemas/common.js';

// ============================================================
// ai-board CLI
// ============================================================

interface CliOptions {
  readonly root: string;
  readonly port: number;
  readonly open: boolean;
  readonly pollIntervalMs: number | undefined;
  readonly pidFile: string | undefined;
}

const USAGE = `使い方: ai-board [options]
       ai-board card <command> [--root <path>]    カードの読み書き（ai-board card --help）
       ai-board status [--json [--only <項目,...>] | --html] [--root <path>]
                                                  ボードの状態と次の一手（サーバ不要）
       ai-board migrate [--from <db>] [--empty] [--root <path>]
                                                  board.db をデータ用ブランチへ書き出す（ai-board migrate --help）
       ai-board pr <command> [--root <path>]      PR の読み書き（gh api の REST。ai-board pr --help）
       ai-board loop <start|finish> [--root <path>]
                                                  ループの 1 手の記録を書く（監視役だけが使う。ai-board loop --help）

計画ファイル駆動のローカル Web ダッシュボードを起動します。

Options:
  --root <path>   対象プロジェクトのルート (既定: カレントディレクトリ)
  --port <n>      待ち受けポート (既定: ${DEFAULT_PORT}、使用中なら自動で繰り上げ)
  --no-open       ブラウザを自動で開かない
  --poll-interval <ms>
                  レビュー要求のポーリング間隔 (既定: 60000)
  --pid-file <path>
                  起動したら、サーバの pid (OS の pid) をこのファイルに書く
  -h, --help      このヘルプを表示
`;

export function parseArgs(argv: readonly string[]): CliOptions | 'help' {
  let root = process.cwd();
  let port = DEFAULT_PORT;
  let open = true;
  let pollIntervalMs: number | undefined;
  let pidFile: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case '-h':
      case '--help':
        return 'help';
      case '--no-open':
        open = false;
        break;
      case '--root':
        root = path.resolve(takeValue(argv, ++i, '--root'));
        break;
      case '--port':
        port = takeInteger(argv, ++i, '--port', 1, 65535);
        break;
      case '--poll-interval':
        pollIntervalMs = takeInteger(argv, ++i, '--poll-interval', 1000, Number.MAX_SAFE_INTEGER);
        break;
      case '--pid-file':
        pidFile = path.resolve(takeValue(argv, ++i, '--pid-file'));
        break;
      default:
        throw new Error(`不明なオプションです: ${String(arg)}`);
    }
  }

  return { root, port, open, pollIntervalMs, pidFile };
}

/** 値を伴うオプションの引数を取り出す */
function takeValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];

  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} には値を指定してください`);
  }

  return value;
}

function takeInteger(
  argv: readonly string[],
  index: number,
  option: string,
  min: number,
  max: number
): number {
  const value = Number(takeValue(argv, index, option));

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${option} には ${min}〜${max} の整数を指定してください`);
  }

  return value;
}

/**
 * `card` サブコマンド。サーバを起動せず、データのワークツリーを直接読み書きする。
 *
 * 読むコマンドは頭で取り直し、書くコマンドは書き込みの 1 操作（コミットと push）として行う。
 */
async function runCard(argv: readonly string[]): Promise<number> {
  const { root, rest } = extractRoot(argv);
  const paths = resolvePaths(root);
  const store = createBoardDataStore(paths, createCliRunner());

  return runCardCli(
    rest,
    { store, cards: createFileCardDependencies(store.dataDir), legacyDb: legacyDbOf(paths) },
    createProcessIo()
  );
}

/**
 * `migrate` サブコマンド。移行前の `board.db` を読み、データ用ブランチを作って push する。
 *
 * 既定の置き場所（`.ai-board/data/`）なら `root` のリポジトリからワークツリーを足して作る。
 * `AI_BOARD_DATA` なら、そのディレクトリ（`origin` を持つ空の clone）に作る。
 */
async function runMigrate(argv: readonly string[]): Promise<number> {
  const { root, rest } = extractRoot(argv);
  const paths = resolvePaths(root);

  return runMigrateCli(
    rest,
    {
      target: {
        dataDir: paths.dataDir,
        ...(paths.dataSource === 'env' ? {} : { repoRoot: paths.root }),
        runner: createCliRunner(),
      },
      defaultFrom: legacyDbPath(paths),
      configFile: path.join(paths.sharedBoardDir, CONFIG_FILE),
      readLegacy: readLegacyBoard,
    },
    createProcessIo()
  );
}

/** 移行前の DB があればその場所。データ用ブランチが無いときに `ai-board migrate` を案内するのに使う */
function legacyDbOf(paths: BoardPaths): string | null {
  const dbPath = legacyDbPath(paths);
  return fs.existsSync(dbPath) ? dbPath : null;
}

/**
 * `status` サブコマンド。サーバを起動せず、ボードと同じ組み立てでステージを導出する。
 *
 * カードは頭で 1 回データ用ブランチを取り直してから読む。
 * PR の状態はポーリングせず、`refresh()` を 1 回だけ待ってから読む。
 * `branch` から解決した PR 番号の書き戻しも、サーバと同じくここで起きる。
 */
async function runStatus(argv: readonly string[]): Promise<number> {
  const { root, rest } = extractRoot(argv);
  const io = createProcessIo();

  // 引数の誤りや --help で、GitHub への問い合わせと PR 番号の書き戻しを起こさない
  const args = parseStatusArgs(rest);
  if (typeof args === 'string') {
    io.stderr(STATUS_USAGE);
    return args === 'help' ? 0 : 1;
  }

  // config.yaml はデータ用ブランチの根にあるので、取り直してから読む
  const paths = resolvePaths(root);
  const runner = createCliRunner();
  const store = createBoardDataStore(paths, runner);

  const refreshed = await store.refresh();
  if (isErr(refreshed)) {
    io.stderr(`${describeDataStoreError(refreshed.error, legacyDbOf(paths))}\n`);
    return 1;
  }
  if (refreshed.value.kind === 'offline') {
    io.stderr(`${describeOfflineRead(refreshed.value.reason)}\n`);
  }

  const config = loadConfig(root);
  const cards = createFileCardDependencies(store.dataDir);
  const { provider, poller } = await createMrStateSource(
    config.forge,
    cards.cardRepository,
    createFileMrSnapshotRepository(store),
    runner,
    // ブランチから解決した PR 番号は、コミットして push する。ファイルに書くだけでは次の取り直しで捨てられる
    { writeMr: createTransactionalMrWriter(store) }
  );
  await poller?.refresh();

  const board = createBoardDependencies(
    config.paths.plansDir,
    cards.cardRepository,
    cards.ideaDividerRepository,
    provider,
    createLoopHistoryRepository(store.dataDir)
  );

  return runStatusCli(
    rest,
    {
      ...board,
      findServer: () => findLiveServer(config.paths.dataDir),
      // implement の段（next.step）を、カードのブランチの計画から読む。git fetch はしない
      branchPlanRepository: createBranchPlanRepository(runner, paths.root),
    },
    io
  );
}

/**
 * `loop` サブコマンド。ループの監視役が 1 手の記録をデータ用ブランチの `loop/` に書く。
 *
 * カードについては、ある ID のカードがあるかを読むだけで、書き込みの口は渡さない。
 */
async function runLoop(argv: readonly string[]): Promise<number> {
  const { root, rest } = extractRoot(argv);
  const paths = resolvePaths(root);
  const store = createBoardDataStore(paths, createCliRunner());
  const { cardRepository } = createFileCardDependencies(store.dataDir);

  return runLoopCli(
    rest,
    {
      store,
      cardExists: async (id) => {
        const parsed = CardIdSchema.safeParse(id);
        return parsed.success && (await cardRepository.findById(parsed.data as CardId)) !== null;
      },
      legacyDb: legacyDbOf(paths),
    },
    createProcessIo()
  );
}

/** `ai-board pr` の `gh` の上限。差分やコメントの全ページは、ポーリングの既定（10 秒）では足りないことがある */
const PR_TIMEOUT_MS = 60_000;

/**
 * `pr` サブコマンド。手順書の `gh pr` を、REST（`gh api`）で置き換える。カードには書かない。
 *
 * `config.yaml` はデータ用ブランチの根にあるので、頭で 1 回取り直してから読む。
 * 取り直せなくても止めない（移行前はデータ用ブランチが無く、`.ai-board/config.yaml` を読む）。
 */
async function runPr(argv: readonly string[]): Promise<number> {
  const { root, rest } = extractRoot(argv);
  const io = createProcessIo();
  const runner = createCliRunner({ timeoutMs: PR_TIMEOUT_MS });

  // 使い方の誤りや --help で、データ用ブランチの取り直しを起こさない
  if (!isPrCommand(rest[0]) || rest.includes('--help') || rest.includes('-h')) {
    return runPrCli(rest, { forge: null, runner }, io);
  }

  const paths = resolvePaths(root);
  const refreshed = await createBoardDataStore(paths, runner).refresh();
  if (isErr(refreshed)) {
    io.stderr(`${describeDataStoreError(refreshed.error, legacyDbOf(paths))}\n`);
  } else if (refreshed.value.kind === 'offline') {
    io.stderr(`${describeOfflineRead(refreshed.value.reason)}\n`);
  }

  return runPrCli(rest, { forge: loadConfig(root).forge, runner }, io);
}

/** `--root <path>` を取り除いた残りの引数を返す */
function extractRoot(argv: readonly string[]): { root: string; rest: string[] } {
  const index = argv.indexOf('--root');
  if (index === -1) {
    return { root: process.cwd(), rest: [...argv] };
  }

  const root = path.resolve(takeValue(argv, index + 1, '--root'));
  return { root, rest: [...argv.slice(0, index), ...argv.slice(index + 2)] };
}

function createProcessIo(): CardCliIo {
  return {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    readStdin: async () => {
      if (process.stdin.isTTY) return null;

      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer);
      }
      return Buffer.concat(chunks).toString('utf-8');
    },
    now: () => new Date(),
  };
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  if (command === 'card') {
    process.exitCode = await runCard(rest);
    return;
  }

  if (command === 'migrate') {
    process.exitCode = await runMigrate(rest);
    return;
  }

  if (command === 'status') {
    process.exitCode = await runStatus(rest);
    return;
  }

  if (command === 'pr') {
    process.exitCode = await runPr(rest);
    return;
  }

  if (command === 'loop') {
    process.exitCode = await runLoop(rest);
    return;
  }

  const parsed = parseArgs(process.argv.slice(2));

  if (parsed === 'help') {
    console.warn(USAGE);
    return;
  }

  const { root, port, open, pollIntervalMs, pidFile } = parsed;

  // 引数を読んだらすぐ書く。--root が無いなどで起動の前に終わったときも、起動を待つ側が
  // pid のファイルからプロセスが終わったことに気づけるように（root の確かめや待ち受けより前）
  if (pidFile !== undefined) {
    writePidFile(pidFile, process.pid);
  }

  if (!fs.existsSync(root)) {
    throw new Error(`ディレクトリが見つかりません: ${root}`);
  }

  warnIfNothingToShow(root);

  const server = await startServer({
    root,
    port,
    ...(pollIntervalMs !== undefined ? { pollIntervalMs } : {}),
  });

  console.warn(`ai-board  ${server.url}`);
  console.warn(`  対象      ${server.config.paths.root}`);
  console.warn(`  取得先    ${describeForge(server.config.forge)}`);
  console.warn(`  データ    ${describeData(server.config.paths)}`);

  if (open) {
    openBrowser(server.url);
  }

  const shutdown = (): void => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** .ai-board が無いディレクトリで起動されたときに気付けるようにする */
function warnIfNothingToShow(root: string): void {
  if (!fs.existsSync(path.join(root, BOARD_DIR))) {
    console.warn(
      `[ai-board] ${root} に ${BOARD_DIR}/ がありません。\n` +
        `           空のボードを表示します。--root で対象を指定できます。`
    );
  }
}

main().catch((error: unknown) => {
  console.error(`[ai-board] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

/** 起動ログに出す取得先の 1 行 */
function describeForge(forge: AppConfig['forge']): string {
  if (forge === null) return '未設定（PR 中 / マージ済みの列は空になります）';

  return `GitHub ${forge.owner}/${forge.repo}（gh のログインを使用）`;
}

/** 起動ログに出すデータのワークツリーの 1 行。ワークツリーから共有しているときは、そうと分かるようにする */
function describeData(paths: AppConfig['paths']): string {
  switch (paths.dataSource) {
    case 'main-checkout':
      return `${paths.dataDir}（メインのチェックアウトと共有）`;
    case 'env':
      return `${paths.dataDir}（${DATA_ENV} で指定）`;
    case 'local':
      return paths.dataDir;
  }
}
