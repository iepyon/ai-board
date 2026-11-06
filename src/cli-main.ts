import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_FILE, loadConfig, resolvePaths } from './shared/config.js';
import { createCliRunner, type CliRunner } from './infrastructure/cli-runner.js';
import type { DataStore } from './infrastructure/data-store.js';
import {
  createBoardDataStore,
  createFileCardDependencies,
  createTransactionalCardDependencies,
  createTransactionalMrWriter,
} from './cards/composition.js';
import { runCardCli, type CardCliIo } from './cards/cli/card-cli.js';
import type { SeedFile } from './cards/cli/seed-cards.js';
import { runInitCli } from './cards/cli/init-cli.js';
import { describeDataStoreError, describeOfflineRead } from './cards/cli/data-store-messages.js';
import {
  createBoardDependencies,
  type BoardDependencies,
  createLoopHistoryRepository,
  createBranchPlanRepository,
  createFileMrSnapshotRepository,
  createMrStateSource,
} from './board/composition.js';
import { parseStatusArgs, runStatusCli, STATUS_USAGE } from './board/cli/status-cli.js';
import { isPrCommand, runPrCli } from './board/cli/pr-cli.js';
import { runLoopCli } from './board/cli/loop-cli.js';
import { DECIDE_USAGE, isDecideCommand, runDecideCli } from './board/cli/decide-cli.js';
import { readHarnessVersion } from './infrastructure/harness-version.js';
import { readSessionTokens } from './infrastructure/session-usage.js';
import { readMtimeMs, runDistCheckCli } from './infrastructure/dist-check-cli.js';
import { err, isErr, ok, type Result } from './shared/result.js';
import { CardIdSchema, type CardId } from './shared/schemas/common.js';

// ============================================================
// ai-board CLI
// ============================================================

const USAGE = `使い方: ai-board <command> [--root <path>]

計画ファイル駆動の開発のボードを、CLI で読み書きする。

Commands:
  card <command>      カードの読み書き（ai-board card --help）
  status [--json [--only <項目,...>]]
                      ボードの状態と次の一手
  init                空のデータ用ブランチを作る（ai-board init --help）
  pr <command>        PR の読み書き（gh api の REST。ai-board pr --help）
  decide <command>    人の判断を書く（人と、人が会話で頼んだ Claude だけ。ai-board decide --help）
  loop <start|finish> ループの 1 手の記録を書く（ループだけが使う。ai-board loop --help）
  dist-check          dist/ が HEAD のコミットより古いかを確かめる（古ければ終了コード 1）

Options:
  --root <path>   対象プロジェクトのルート (既定: カレントディレクトリ)
  -h, --help      このヘルプを表示
`;

/** 値を伴うオプションの引数を取り出す */
function takeValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];

  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} には値を指定してください`);
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
    { store, cards: createFileCardDependencies(store.dataDir) },
    createProcessIo()
  );
}

/**
 * `init` サブコマンド。空のデータ用ブランチを作って push する。
 *
 * 既定の置き場所（`.ai-board/data/`）なら `root` のリポジトリからワークツリーを足して作る。
 * `AI_BOARD_DATA` なら、そのディレクトリ（`origin` を持つ空の clone）に作る。
 */
async function runInit(argv: readonly string[]): Promise<number> {
  const { root, rest } = extractRoot(argv);
  const paths = resolvePaths(root);

  return runInitCli(
    rest,
    {
      target: {
        dataDir: paths.dataDir,
        ...(paths.dataSource === 'env' ? {} : { repoRoot: paths.root }),
        runner: createCliRunner(),
      },
      configFile: path.join(paths.sharedBoardDir, CONFIG_FILE),
    },
    createProcessIo()
  );
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
    io.stderr(`${describeDataStoreError(refreshed.error)}\n`);
    return 1;
  }
  if (refreshed.value.kind === 'offline') {
    io.stderr(`${describeOfflineRead(refreshed.value.reason)}\n`);
  }

  const board = await assembleBoard(root, store, runner);

  return runStatusCli(
    rest,
    {
      ...board,
      // implement の段（next.step）を、カードのブランチの計画から読む。git fetch はしない
      branchPlanRepository: createBranchPlanRepository(runner, paths.root),
    },
    io
  );
}

/**
 * `status` と `decide` が使う、サーバと同じ組み立てのボード。データ用ブランチは呼び出し側が取り直しておく。
 *
 * PR の状態はポーリングせず、`refresh()` を 1 回だけ待ってから読む。
 * `branch` から解決した PR 番号の書き戻しも、サーバと同じくここで起きる。
 */
async function assembleBoard(
  root: string,
  store: DataStore,
  runner: CliRunner
): Promise<BoardDependencies> {
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

  return createBoardDependencies(
    config.paths.plansDir,
    cards.cardRepository,
    cards.ideaDividerRepository,
    provider,
    createLoopHistoryRepository(store.dataDir)
  );
}

/**
 * `decide` サブコマンド。人がチャットで頼んだ判断を、サーバを起動せずに書く。
 *
 * 書く前に `status` と同じ組み立てでボードを導出し、画面で押せる判断かを確かめる。
 * 書き込みはサーバと同じ組み立て（`createTransactionalCardDependencies`）の usecase で、コミットして push する。
 * 書いた後のボードは、取り直した PR の状態のまま組み立て直す（列の移りを出すため）。
 */
async function runDecide(argv: readonly string[]): Promise<number> {
  const { root, rest } = extractRoot(argv);
  const io = createProcessIo();

  // 使い方の誤りや --help で、データ用ブランチの取り直しと GitHub への問い合わせを起こさない
  const help = rest.includes('--help') || rest.includes('-h');
  if (!isDecideCommand(rest[0]) || help) {
    io.stderr(DECIDE_USAGE);
    return rest.length === 0 || help ? 0 : 1;
  }

  const paths = resolvePaths(root);
  const runner = createCliRunner();
  const store = createBoardDataStore(paths, runner);

  const refreshed = await store.refresh();
  if (isErr(refreshed)) {
    io.stderr(`${describeDataStoreError(refreshed.error)}\n`);
    return 1;
  }
  if (refreshed.value.kind === 'offline') {
    io.stderr(`${describeOfflineRead(refreshed.value.reason)}\n`);
  }

  const board = await assembleBoard(root, store, runner);

  return runDecideCli(
    rest,
    { loadBoard: board.getBoardQuery, cards: createTransactionalCardDependencies(store) },
    io
  );
}

/**
 * `loop` サブコマンド。ループ（本筋のセッション）が 1 手の記録をデータ用ブランチの `loop/` に書く。
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
      harnessVersion: () => readHarnessVersion(root),
      countTokens: readSessionTokens,
    },
    createProcessIo()
  );
}

/**
 * `dist-check` サブコマンド。`<root>/dist/cli.js` が `<root>` の HEAD のコミットより古いかを終了コードで返す。
 *
 * データ用ブランチは取り直さない（ビルドの要否だけを見る）。
 */
async function runDistCheck(argv: readonly string[]): Promise<number> {
  const { root, rest } = extractRoot(argv);

  return runDistCheckCli(
    rest,
    { root, runner: createCliRunner(), mtimeMs: readMtimeMs },
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
    io.stderr(`${describeDataStoreError(refreshed.error)}\n`);
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
    readMarkdownDir,
    now: () => new Date(),
  };
}

/** ディレクトリの直下の `*.md`（下の階層は読まない）を読む。相対パスは作業ディレクトリから解決する */
async function readMarkdownDir(dir: string): Promise<Result<readonly SeedFile[], string>> {
  try {
    const root = path.resolve(dir);
    const entries = await fs.promises.readdir(root, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md'));

    return ok(
      await Promise.all(
        files.map(async (entry) => ({
          name: entry.name,
          content: await fs.promises.readFile(path.join(root, entry.name), 'utf-8'),
        }))
      )
    );
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

/** サーバを起動しないサブコマンド。名前から実行する関数を引く */
const SUBCOMMANDS: Readonly<Record<string, (argv: readonly string[]) => Promise<number>>> = {
  card: runCard,
  init: runInit,
  status: runStatus,
  pr: runPr,
  loop: runLoop,
  decide: runDecide,
  'dist-check': runDistCheck,
};

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  const subcommand = command === undefined ? undefined : SUBCOMMANDS[command];
  if (subcommand !== undefined && Object.hasOwn(SUBCOMMANDS, command ?? '')) {
    process.exitCode = await subcommand(rest);
    return;
  }

  if (command === '-h' || command === '--help') {
    console.warn(USAGE);
    return;
  }

  if (command !== undefined) console.error(`[ai-board] 不明なコマンドです: ${command}`);
  console.warn(USAGE);
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`[ai-board] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
