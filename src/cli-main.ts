import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startServer, DEFAULT_PORT } from './server.js';
import { BOARD_DIR, resolvePaths, type AppConfig } from './shared/config.js';
import { openDatabase } from './infrastructure/database.js';
import { createCardDependencies } from './cards/composition.js';
import { runCardCli, runImport, type CardCliIo } from './cards/cli/card-cli.js';

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
       ai-board import [--from <dir>] [--root <path>]
                                                  .ai-board/cards/*.md を DB に取り込む

計画ファイル駆動のローカル Web カンバンを起動します。

Options:
  --root <path>   対象プロジェクトのルート (既定: カレントディレクトリ)
  --port <n>      待ち受けポート (既定: ${DEFAULT_PORT}、使用中なら自動で繰り上げ)
  --no-open       ブラウザを自動で開かない
  --poll-interval <ms>
                  レビュー要求のポーリング間隔 (既定: 30000)
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
 * `card` / `import` サブコマンド。サーバを起動せず DB を直接開く。
 * サーバが動いていれば、その書き込みは data_version 経由で画面に届く。
 */
async function runSubcommand(command: 'card' | 'import', argv: readonly string[]): Promise<number> {
  const { root, rest } = extractRoot(argv);
  const paths = resolvePaths(root);
  const db = openDatabase(paths.dbPath);

  try {
    const deps = createCardDependencies(db);
    const io = createProcessIo();

    if (command === 'card') {
      return await runCardCli(rest, deps, io);
    }

    const fromIndex = rest.indexOf('--from');
    const from =
      fromIndex === -1 ? paths.cardsDir : path.resolve(takeValue(rest, fromIndex + 1, '--from'));
    return await runImport(from, deps, io);
  } finally {
    db.close();
  }
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

  if (command === 'card' || command === 'import') {
    process.exitCode = await runSubcommand(command, rest);
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
