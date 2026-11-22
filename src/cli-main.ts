import * as fs from 'node:fs';
import * as path from 'node:path';
import { BOARD_DIR, loadConfig, resolvePaths, type BoardPaths } from './infrastructure/config.js';
import { createCliRunner } from './infrastructure/cli-runner.js';
import { createBoardStore, createCardCliParts } from './cards/composition.js';
import { CARD_COLLECTION } from './cards/repositories/card-files.js';
import { runCardCli, type CardCliIo } from './cards/cli/card-cli.js';
import { SEED_ORDER_FILE, type SeedFile } from './cards/cli/seed-cards.js';
import { runStoreCli } from './cards/cli/store-cli.js';
import { readDataBranchDocuments } from './cards/repositories/data-branch-import.js';
import type { ArtifactMirrorStore } from './infrastructure/artifact-mirror-store.js';
import { describeStoreError } from './infrastructure/store-messages.js';
import { assembleBoard } from './board/composition.js';
import { parseStatusArgs, runStatusCli, STATUS_USAGE } from './board/cli/status-cli.js';
import { isPrCommand, runPrCli } from './board/cli/pr-cli.js';
import { runLoopCli } from './board/cli/loop-cli.js';
import { DECIDE_USAGE, isDecideCommand, runDecideCli } from './board/cli/decide-cli.js';
import { readMtimeMs, runDistCheckCli } from './infrastructure/dist-check-cli.js';
import { err, ok, type Result } from './shared/result.js';
import { CardIdSchema } from './shared/schemas/common.js';

// ============================================================
// ai-board CLI
// ============================================================

const USAGE = `使い方: ai-board <command> [--root <path>]

計画ファイル駆動の開発のボードを、CLI で読み書きする。

Commands:
  card <command>      カードの読み書き（ai-board card --help）
  status [--json [--only <項目,...>]]
                      ボードの状態と次の一手
  store <command>     置き場所（Artifact の DB）の写しと送る箱（ai-board store --help）
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

/** 置き場所の URL が設定されていなければ、理由を出して false */
function requireStoreUrl(root: string, io: CardCliIo): boolean {
  // AI_BOARD_STORE で試しの写しを指すときは、置き場所の URL を問わない（送らなければ置き場所に届かない）
  const config = loadConfig(root);
  if (config.storeUrl !== null || config.paths.storeSource === 'env') return true;
  io.stderr(`${describeStoreError({ type: 'StoreNotConfigured' })}\n`);
  return false;
}

/**
 * 書き込みの後に、送る箱に送っていない書き込みが残っていれば知らせる。
 * Claude はこれを読んで送り出す（board-store のスキル）
 */
function remindOutbox(store: ArtifactMirrorStore, io: CardCliIo): void {
  const pending = store.pendingWrites();
  if (pending === 0) return;
  io.stderr(
    `[ai-board] 送る箱に ${pending} 束の書き込みがあります。置き場所へ送り出してください（board-store のスキル。ai-board store outbox --json）\n`
  );
}

/** 写しを確かめる。読めなければ理由を出して false */
async function checkStore(store: ArtifactMirrorStore, io: CardCliIo): Promise<boolean> {
  const checked = await store.check();
  if (checked.ok) return true;
  io.stderr(`${describeStoreError(checked.error)}\n`);
  return false;
}

/**
 * `card` サブコマンド。置き場所の写しを読み、書き込みは送る箱に積む。
 */
async function runCard(argv: readonly string[]): Promise<number> {
  const { root, rest } = extractRoot(argv);
  const io = createProcessIo();
  if (
    !rest.includes('--help') &&
    !rest.includes('-h') &&
    rest.length > 0 &&
    !requireStoreUrl(root, io)
  ) {
    return 1;
  }
  const paths = resolvePaths(root);
  const store = createBoardStore(paths);

  const code = await runCardCli(
    rest,
    { store, storeDir: paths.storeDir, ...createCardCliParts(store) },
    io
  );
  remindOutbox(store, io);
  return code;
}

/**
 * `store` サブコマンド。置き場所（Artifact の DB）と手元の写し・送る箱の間を行き来する。
 */
async function runStore(argv: readonly string[]): Promise<number> {
  const { root, rest } = extractRoot(argv);
  const io = createProcessIo();
  const paths: BoardPaths = resolvePaths(root);
  const store = createBoardStore(paths);

  return runStoreCli(
    rest,
    {
      store,
      readDataBranch: readDataBranchDocuments,
      runSeed: (dir) => runCard(['seed', '--from', dir, '--root', root]),
      seedDir: path.join(root, BOARD_DIR, SEED_DIR),
    },
    io
  );
}

/** `ai-board store seed` の既定の置き場所（`.ai-board/seed/`） */
const SEED_DIR = 'seed';

/**
 * `status` サブコマンド。ボードを組み立て、ステージを導出する。
 *
 * カードは置き場所の写しから読む（取り込みは Claude が board-store のスキルで先に行う）。
 * PR の状態は`refresh()` を 1 回だけ待ってから読む。
 * `branch` から解決した PR 番号の書き戻しも、ここで起きる（`board/composition.ts` の `assembleBoard`）。
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

  if (!requireStoreUrl(root, io)) return 1;
  const paths = resolvePaths(root);
  const runner = createCliRunner();
  const store = createBoardStore(paths);
  if (!(await checkStore(store, io))) return 1;

  const board = await assembleBoard(root, store, runner);

  const code = await runStatusCli(rest, { getStatusQuery: board.getStatusQuery }, io);
  remindOutbox(store, io);
  return code;
}

/**
 * `decide` サブコマンド。人がチャットで頼んだ判断を書く。
 *
 * 置き場所の写しを確かめ、`status` と同じ組み立てのボード（`assembleBoard`）から、判断を書く usecase（`decide`）を渡す。
 * 導出・検査・書き込み・束の名前・書いた後の列の読み直しは usecase（`decide.command.ts`）が行う。書いたものは送る箱に積まれる。
 * PR の状態は頭で 1 回取り直したものを使い、書き込みの中でも書いた後でも問い合わせない。
 */
async function runDecide(argv: readonly string[]): Promise<number> {
  const { root, rest } = extractRoot(argv);
  const io = createProcessIo();

  // 使い方の誤りや --help で、GitHub への問い合わせを起こさない
  const help = rest.includes('--help') || rest.includes('-h');
  if (!isDecideCommand(rest[0]) || help) {
    io.stderr(DECIDE_USAGE);
    return rest.length === 0 || help ? 0 : 1;
  }

  if (!requireStoreUrl(root, io)) return 1;
  const paths = resolvePaths(root);
  const runner = createCliRunner();
  const store = createBoardStore(paths);
  if (!(await checkStore(store, io))) return 1;

  const board = await assembleBoard(root, store, runner);

  const code = await runDecideCli(rest, { decide: board.decide }, io);
  remindOutbox(store, io);
  return code;
}

/**
 * `loop` サブコマンド。ループ（本筋のセッション）が 1 手の記録を置き場所の `loop` に書く（送る箱に積む）。
 *
 * カードについては、ある ID のカードがあるかを読むだけで、書き込みの口は渡さない。
 */
async function runLoop(argv: readonly string[]): Promise<number> {
  const { root, rest } = extractRoot(argv);
  const io = createProcessIo();
  const paths = resolvePaths(root);
  const store = createBoardStore(paths);
  // 使い方の誤りや --help のほかは、カードを読む前に置き場所を確かめる（読み込む実装はここで読む）
  const help = rest.length === 0 || rest.includes('--help') || rest.includes('-h');
  if (!help && !(await checkStore(store, io))) return 1;

  const code = await runLoopCli(
    rest,
    {
      store,
      // カードを組み立てずに、カードの文書があるかだけを見る
      cardExists: (id) =>
        Promise.resolve(
          CardIdSchema.safeParse(id).success && store.get(CARD_COLLECTION, id) !== null
        ),
    },
    io
  );
  remindOutbox(store, io);
  return code;
}

/**
 * `dist-check` サブコマンド。`<root>/dist/cli.js` が `<root>` の HEAD のコミットより古いかを終了コードで返す。
 *
 * 置き場所には触れない（ビルドの要否だけを見る）。
 */
async function runDistCheck(argv: readonly string[]): Promise<number> {
  const { root, rest } = extractRoot(argv);

  return runDistCheckCli(
    rest,
    { root, runner: createCliRunner(), mtimeMs: readMtimeMs },
    createProcessIo()
  );
}

/** `ai-board pr` の `gh` の上限。差分やコメントの全ページは、既定の上限（10 秒）では足りないことがある */
const PR_TIMEOUT_MS = 60_000;

/**
 * `pr` サブコマンド。手順書の `gh pr` を、REST（`gh api`）で置き換える。カードには書かない。
 *
 * `config.yaml` は git に載せた `.ai-board/config.yaml` から読む。
 */
async function runPr(argv: readonly string[]): Promise<number> {
  const { root, rest } = extractRoot(argv);
  const io = createProcessIo();
  const runner = createCliRunner({ timeoutMs: PR_TIMEOUT_MS });

  // 使い方の誤りや --help では設定を読まない
  if (!isPrCommand(rest[0]) || rest.includes('--help') || rest.includes('-h')) {
    return runPrCli(rest, { forge: null, runner }, io);
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
    readSeedOrder,
    writeMarkdownFiles,
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

/** ディレクトリの直下の起票する順のファイル（`SEED_ORDER_FILE`）を読む。無ければ null。相対パスは作業ディレクトリから解決する */
async function readSeedOrder(dir: string): Promise<Result<string | null, string>> {
  try {
    return ok(await fs.promises.readFile(path.join(path.resolve(dir), SEED_ORDER_FILE), 'utf-8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ok(null);
    return err(error instanceof Error ? error.message : String(error));
  }
}

/**
 * ディレクトリ（無ければ作る）に `*.md` を書く。相対パスは作業ディレクトリから解決する。
 * 先に全部の名前を確かめ、同じ名前のファイルが 1 つでもあれば 1 つも書かない（手で直したファイルを上書きしない）
 */
async function writeMarkdownFiles(
  dir: string,
  files: readonly SeedFile[]
): Promise<Result<void, string>> {
  try {
    const root = path.resolve(dir);
    await fs.promises.mkdir(root, { recursive: true });

    const existing = new Set(await fs.promises.readdir(root));
    const clashes = files.filter((file) => existing.has(file.name)).map((file) => file.name);
    if (clashes.length > 0) {
      return err(`既にあるファイル: ${clashes.join(', ')}`);
    }

    for (const file of files) {
      await fs.promises.writeFile(path.join(root, file.name), file.content, {
        encoding: 'utf-8',
        flag: 'wx',
      });
    }
    return ok(undefined);
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

/** サブコマンド。名前から実行する関数を引く */
const SUBCOMMANDS: Readonly<Record<string, (argv: readonly string[]) => Promise<number>>> = {
  card: runCard,
  store: runStore,
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
