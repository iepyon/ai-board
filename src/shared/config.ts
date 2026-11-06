import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { locateWorktree } from './git-worktree.js';

// ============================================================
// ai-board の設定
// ============================================================

export const BOARD_DIR = '.ai-board';
export const CONFIG_FILE = 'config.yaml';
export const PLANS_DIR = 'plans';
/** データ用ブランチのワークツリーの置き場所（`sharedBoardDir` の下） */
export const DATA_DIR = 'data';
/**
 * データのワークツリーの代わりに使うディレクトリ（git のリポジトリ）を明示する環境変数。
 * ワークツリーで共有のカードを汚さずに試すときに使う。そのディレクトリの `origin` に push する
 */
export const DATA_ENV = 'AI_BOARD_DATA';
/**
 * データ用ブランチの読み書きのモードを書くファイル。データのワークツリーの隣（ロックと同じ親）に置き、git に載せない。
 * `mode: local` なら手元モード（`origin` に触れずに手元の commit だけで読み書きする）、無ければ既定のモード
 */
export const DATA_MODE_FILE = 'data-mode.yaml';

/** データ用ブランチの読み書きのモード（`DataStoreOptions` の `mode`） */
export type DataMode = 'sync' | 'local';

const DataModeFileSchema = z.object({ mode: z.enum(['sync', 'local']) });

/** GitHub は API パスが owner/repo 固定なので数値 id を受ける意味が無い */
const GitHubConfigSchema = z.object({
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'repository は owner/repo の形式で書く'),
});

const ConfigFileSchema = z.object({
  github: GitHubConfigSchema.optional(),
});

/**
 * レビュー要求の取得先。
 *
 * アクセストークンは持たない。認証は gh CLI に委ねる。
 */
export interface ForgeConfig {
  readonly kind: 'github';
  readonly owner: string;
  readonly repo: string;
}

export interface BoardPaths {
  /** 対象プロジェクトのルート */
  readonly root: string;
  /** .ai-board/ */
  readonly boardDir: string;
  /**
   * git に載らない各自のファイル（データのワークツリーと config.yaml）を置く .ai-board/。
   * リンクされたワークツリーではメインのチェックアウトのもの、それ以外は `boardDir` と同じ
   */
  readonly sharedBoardDir: string;
  /** データ用ブランチのワークツリー。既定は `sharedBoardDir` の下の data/ */
  readonly dataDir: string;
  /** データのワークツリーの場所をどう決めたか（起動ログに出す） */
  readonly dataSource: 'local' | 'main-checkout' | 'env';
  /** データ用ブランチの読み書きのモード。`<dataDir の親>/data-mode.yaml` から読む。無ければ `sync` */
  readonly dataMode: DataMode;
  /** .ai-board/plans/（git でブランチに乗るので、常に `root` の下） */
  readonly plansDir: string;
}

export interface AppConfig {
  readonly paths: BoardPaths;
  /** 取得先が未設定なら null（ボードはカードと計画ファイルだけで動く） */
  readonly forge: ForgeConfig | null;
}

/**
 * 置き場所を決める。
 *
 * 計画ファイルは git でブランチに乗るので `root` の下を読む。
 * データのワークツリーは git の作業ツリーとしては各自のものなので、リンクされたワークツリーでは
 * メインのチェックアウトのものを使う。全ワークツリーで 1 つのバックログを共有するため。
 */
export function resolvePaths(root: string, env: NodeJS.ProcessEnv = process.env): BoardPaths {
  const absoluteRoot = path.resolve(root);
  const boardDir = path.join(absoluteRoot, BOARD_DIR);
  const sharedBoardDir = resolveSharedBoardDir(absoluteRoot, boardDir);
  const dataFromEnv = env[DATA_ENV] ?? '';
  const sharedSource = sharedBoardDir !== boardDir ? 'main-checkout' : 'local';

  const dataDir =
    dataFromEnv !== '' ? path.resolve(dataFromEnv) : path.join(sharedBoardDir, DATA_DIR);

  return {
    root: absoluteRoot,
    boardDir,
    sharedBoardDir,
    dataDir,
    dataSource: dataFromEnv !== '' ? 'env' : sharedSource,
    dataMode: readDataMode(path.join(path.dirname(dataDir), DATA_MODE_FILE)),
    plansDir: path.join(boardDir, PLANS_DIR),
  };
}

/**
 * モードのファイルを読む。無ければ既定のモード。
 *
 * 読めない・形が違うときは、警告して既定のモードにする。既定のモードでも、オフラインなら書き込みは失敗し、
 * 手元の commit は取り直しの守り（`DataStoreLocalAhead`）が止めるので、黙って消えはしない。
 */
function readDataMode(file: string): DataMode {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'sync';
    console.warn(
      `[ai-board] ${file} を読めないため、既定のモード（sync）で動きます: ${String(error)}`
    );
    return 'sync';
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    console.warn(
      `[ai-board] ${file} を読めないため、既定のモード（sync）で動きます: ${String(error)}`
    );
    return 'sync';
  }

  const mode = DataModeFileSchema.safeParse(parsed);
  if (!mode.success) {
    console.warn(
      `[ai-board] ${file} を読めないため、既定のモード（sync）で動きます: mode には sync か local を書いてください`
    );
    return 'sync';
  }
  return mode.data.mode;
}

function resolveSharedBoardDir(root: string, boardDir: string): string {
  const location = locateWorktree(root);

  switch (location.kind) {
    case 'linked':
      return path.join(location.mainRoot, BOARD_DIR);
    case 'standalone':
      return boardDir;
    case 'unresolved':
      // ボードが開かないより、ワークツリーの下のデータで開く方が良い
      console.warn(
        `[ai-board] メインのチェックアウトを求められないため、${boardDir} の下のデータを使います: ${location.reason}`
      );
      return boardDir;
  }
}

/**
 * 設定を読み込む。
 *
 * config.yaml はデータ用ブランチの根（`dataDir`）から読む。クラウドの clone には
 * git に載らない各自のファイルが無いからである。データ用ブランチに無ければ、
 * 切り替えの前後で手元が止まらないよう `sharedBoardDir` の config.yaml を読む。
 *
 * 設定ファイルが無い、取得先のセクションが無いのいずれの場合も
 * 連携は無効になるだけでエラーにはしない。
 */
export function loadConfig(root: string, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const paths = resolvePaths(root, env);
  const configPath = resolveConfigPath(paths);

  let raw: unknown = {};
  if (fs.existsSync(configPath)) {
    raw = parseYaml(fs.readFileSync(configPath, 'utf-8')) ?? {};
  }

  const parsed = ConfigFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${configPath} の内容が不正です: ${parsed.error.issues.map((i) => i.message).join(', ')}`
    );
  }

  return { paths, forge: toForgeConfig(parsed.data) };
}

/** データ用ブランチの根の config.yaml を優先し、無ければ `sharedBoardDir` のものを使う */
function resolveConfigPath(paths: BoardPaths): string {
  const inData = path.join(paths.dataDir, CONFIG_FILE);
  return fs.existsSync(inData) ? inData : path.join(paths.sharedBoardDir, CONFIG_FILE);
}

function toForgeConfig(data: z.infer<typeof ConfigFileSchema>): ForgeConfig | null {
  if (data.github !== undefined) {
    const [owner, repo] = data.github.repository.split('/');
    // スキーマの正規表現が owner/repo を保証しているが、型の上では undefined を取り得る
    if (owner !== undefined && repo !== undefined) {
      return { kind: 'github', owner, repo };
    }
  }

  return null;
}
