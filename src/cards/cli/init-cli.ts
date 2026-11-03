import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_FILE } from '../../shared/config.js';
import { isErr } from '../../shared/result.js';
import {
  createDataBranch,
  type CreateDataBranchOptions,
  type DataBranchCreateError,
} from '../../infrastructure/data-store.js';
import {
  DATA_VERSION_FILE,
  ORDER_FILE,
  serializeDataVersion,
  serializeOrder,
} from '../repositories/card-files.js';
import { describeDataStoreError } from './data-store-messages.js';

// ============================================================
// ai-board init — 空のデータ用ブランチを作る
// ============================================================

export const INIT_USAGE = `使い方: ai-board init [--root <path>]

空のデータ用ブランチ（origin の ai-board/data）を作って push します。
新しいリポジトリで ai-board を使い始めるときに 1 回だけ走らせます。データ用ブランチが既にあれば、何もせずに止まります。

Options:
  -h, --help    このヘルプを表示
`;

export interface InitCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface InitCliDependencies {
  /** データ用ブランチを作る場所 */
  readonly target: CreateDataBranchOptions;
  /** データ用ブランチの根に写す `config.yaml`。無ければ写さない */
  readonly configFile: string;
}

/**
 * `ai-board init` を実行し、終了コードを返す。
 *
 * 形の版のファイル・空の `order.yaml`・（あれば）`config.yaml` の写しを 1 コミットにして、データ用ブランチを作って push する。
 * データ用ブランチが `origin` か手元に既にあれば、何もせずに止まる。
 */
export async function runInitCli(
  argv: readonly string[],
  deps: InitCliDependencies,
  io: InitCliIo
): Promise<number> {
  const args = parseInitArgs(argv);
  if (args !== null) {
    io.stderr(args === 'help' ? INIT_USAGE : `${args}\n${INIT_USAGE}`);
    return args === 'help' ? 0 : 1;
  }

  // config.yaml はデータ用ブランチの有無を確かめた後に読む（読めなくても「既にあります」の案内を先に出す）
  const created = await createDataBranch(
    deps.target,
    'data: 空のデータ用ブランチを作る',
    (dataDir) => writeFiles(dataDir, initialFiles(readFileOrNull(deps.configFile)))
  );
  if (isErr(created)) {
    io.stderr(`${describeBranchError(created.error, deps.target)}\n`);
    return 1;
  }

  const sent = created.value.pushed
    ? 'origin の ai-board/data へ push しました'
    : 'origin が無いため、push せずにコミットだけしました';
  io.stdout(`空のデータ用ブランチを作りました（${path.resolve(deps.target.dataDir)}）\n${sent}\n`);
  return 0;
}

/** 引数を読む。正しければ null、`--help` なら `'help'`、誤りならその文 */
function parseInitArgs(argv: readonly string[]): 'help' | string | null {
  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') return 'help';
  }
  const unknown = argv[0];
  return unknown === undefined ? null : `不明な引数です: ${unknown}`;
}

/** 空のデータ用ブランチに置くファイル（データ用ブランチの根からの相対パスと中身） */
function initialFiles(config: string | null): Map<string, string> {
  const files = new Map<string, string>();
  files.set(DATA_VERSION_FILE, serializeDataVersion());
  files.set(ORDER_FILE, serializeOrder({ divider: null, ranks: {} }));
  if (config !== null) files.set(CONFIG_FILE, config);
  return files;
}

function writeFiles(dir: string, files: ReadonlyMap<string, string>): void {
  for (const [relative, content] of files) {
    const target = path.join(dir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function describeBranchError(
  error: DataBranchCreateError,
  target: CreateDataBranchOptions
): string {
  switch (error.type) {
    case 'DataBranchExists':
      return error.where === 'origin'
        ? 'データ用ブランチ（origin の ai-board/data）が既にあります。何もせずに止まりました'
        : '手元に ai-board/data のブランチが既にあります（origin にはありません）。' +
            '中身を確かめ、要らなければ git branch -D ai-board/data で消してからやり直してください';
    case 'DataDirNotEmpty':
      return `${error.dataDir} に既にファイルがあります。中身を確かめ、要らなければ消してからやり直してください`;
    case 'DataDirNotRepository':
      return target.repoRoot === undefined
        ? `${error.dataDir} は git の clone ではありません。AI_BOARD_DATA には、origin を持つ空の clone を指してください`
        : describeDataStoreError(error);
    case 'DataStoreFetchFailed':
      return `origin に問い合わせられないため、データ用ブランチの有無を確かめられません（${error.message}）`;
    default:
      return describeDataStoreError(error);
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
