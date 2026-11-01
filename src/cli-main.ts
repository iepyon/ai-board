import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startServer, DEFAULT_PORT } from './server.js';
import {
  BOARD_DIR,
  DATA_ENV,
  loadConfig,
  resolvePaths,
  type AppConfig,
  type BoardPaths,
} from './shared/config.js';
import { openDatabase } from './infrastructure/database.js';
import { createCliRunner } from './infrastructure/cli-runner.js';
import {
  createBoardDataStore,
  createCardDependencies,
  createFileCardDependencies,
} from './cards/composition.js';
import { runCardCli, runImport, type CardCliIo } from './cards/cli/card-cli.js';
import { describeDataStoreError, describeOfflineRead } from './cards/cli/data-store-messages.js';
import {
  createBoardDependencies,
  createFileMrSnapshotRepository,
  createMrStateSource,
} from './board/composition.js';
import { parseStatusArgs, runStatusCli, STATUS_USAGE } from './board/cli/status-cli.js';
import { findLiveServer } from './infrastructure/server-info.js';
import { isErr } from './shared/result.js';

// ============================================================
// ai-board CLI
// ============================================================

interface CliOptions {
  readonly root: string;
  readonly port: number;
  readonly open: boolean;
  readonly pollIntervalMs: number | undefined;
}

const USAGE = `使い方: ai-board [options]
       ai-board card <command> [--root <path>]    カードの読み書き（ai-board card --help）
       ai-board status [--json] [--root <path>]   ボードの状態と次の一手（サーバ不要）
       ai-board import [--from <dir>] [--root <path>]
                                                  .ai-board/cards/*.md を DB に取り込む

計画ファイル駆動のローカル Web ダッシュボードを起動します。

Options:
  --root <path>   対象プロジェクトのルート (既定: カレントディレクトリ)
  --port <n>      待ち受けポート (既定: ${DEFAULT_PORT}、使用中なら自動で繰り上げ)
  --no-open       ブラウザを自動で開かない
  --poll-interval <ms>
                  レビュー要求のポーリング間隔 (既定: 60000)
  -h, --help      このヘルプを表示
`;

export function parseArgs(argv: readonly string[]): CliOptions | 'help' {
  let root = process.cwd();
  let port = DEFAULT_PORT;
  let open = true;
  let pollIntervalMs: number | undefined;

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
      default:
        throw new Error(`不明なオプションです: ${String(arg)}`);
    }
  }

  return { root, port, open, pollIntervalMs };
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

/** `import` サブコマンド。移行前の Markdown カードを DB に取り込む */
async function runImportCommand(argv: readonly string[]): Promise<number> {
  const { root, rest } = extractRoot(argv);
  const paths = resolvePaths(root);
  const db = openDatabase(paths.dbPath);

  try {
    const fromIndex = rest.indexOf('--from');
    const from =
      fromIndex === -1 ? paths.cardsDir : path.resolve(takeValue(rest, fromIndex + 1, '--from'));
    return await runImport(from, createCardDependencies(db), createProcessIo());
  } finally {
    db.close();
  }
}

/** 移行前の DB があればその場所。データ用ブランチが無いときに `ai-board migrate` を案内するのに使う */
function legacyDbOf(paths: BoardPaths): string | null {
  return fs.existsSync(paths.dbPath) ? paths.dbPath : null;
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
    runner
  );
  await poller?.refresh();

  const board = createBoardDependencies(
    config.paths.plansDir,
    cards.cardRepository,
    cards.ideaDividerRepository,
    provider
  );

  return runStatusCli(
    rest,
    { ...board, findServer: () => findLiveServer(config.paths.dataDir) },
    io
  );
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

  if (command === 'import') {
    process.exitCode = await runImportCommand(rest);
    return;
  }

  if (command === 'status') {
    process.exitCode = await runStatus(rest);
    return;
  }

  const parsed = parseArgs(process.argv.slice(2));

  if (parsed === 'help') {
    console.warn(USAGE);
    return;
  }

  const { root, port, open, pollIntervalMs } = parsed;

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

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';

  try {
    spawn(command, [url], { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // ブラウザが開けなくても URL は表示済みなので致命的ではない
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
