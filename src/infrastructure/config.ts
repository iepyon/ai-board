import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { locateWorktree } from './git-worktree.js';
import { isRemoteName } from './git-document-store.js';

// ============================================================
// ai-board の設定
// ============================================================

export const BOARD_DIR = '.ai-board';
export const CONFIG_FILE = 'config.yaml';
/** git に載せない各自のファイル（PR の控え・ループの記録・ロック・ボードの HTML）を置くディレクトリ（`sharedBoardDir` の下） */
export const LOCAL_DIR = 'local';
/**
 * 置き場所のリモートの代わりに使う git のリポジトリ（`git init --bare` したもの）のパスを明示する環境変数。
 * 共有のカードを汚さずに試すときに使う。手元のファイルもそのパスの隣の `<パス>.local/` に置く
 */
export const STORE_ENV = 'AI_BOARD_STORE';
/** 置き場所のリモートとブランチの既定 */
export const DEFAULT_STORE_REMOTE = 'origin';
export const DEFAULT_STORE_BRANCH = 'main';

/** GitHub は API パスが owner/repo 固定なので数値 id を受ける意味が無い */
const GitHubConfigSchema = z.object({
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'repository は owner/repo の形式で書く'),
});

/** git の引数として読まれないよう、`-` で始まる値を拒む */
const GitValueSchema = (name: string) =>
  z
    .string()
    .min(1)
    .regex(/^[^-\s][^\s]*$/, `${name} は空白を含まず、- で始まらない値にする`);

/** 置き場所。git のリポジトリの 1 つのブランチの `.ai-board/` */
const StoreConfigSchema = z.object({
  remote: GitValueSchema('store.remote').nullable().optional(),
  branch: GitValueSchema('store.branch').nullable().optional(),
});

const ConfigFileSchema = z.object({
  github: GitHubConfigSchema.optional(),
  store: StoreConfigSchema.optional(),
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
   * git に載らない各自のファイルを置く .ai-board/。
   * リンクされたワークツリーではメインのチェックアウトのもの、それ以外は `boardDir` と同じ
   */
  readonly sharedBoardDir: string;
  /** git を走らせるリポジトリ（メインのチェックアウト。`sharedBoardDir` の親） */
  readonly repoDir: string;
  /** git に載せない各自のファイルのディレクトリ。既定は `sharedBoardDir` の下の local/ */
  readonly localDir: string;
  /** `AI_BOARD_STORE` で指した置き場所のリポジトリ。指していなければ null */
  readonly storeOverride: string | null;
}

export interface AppConfig {
  readonly paths: BoardPaths;
  /** 取得先が未設定なら null（ボードはカードと計画ファイルだけで動く） */
  readonly forge: ForgeConfig | null;
  /** カードの置き場所（git のリモートとブランチ） */
  readonly store: StoreConfig;
}

export interface StoreConfig {
  /** リモートの名前か、リポジトリのパス・URL（`AI_BOARD_STORE` を指せばそのパス） */
  readonly remote: string;
  readonly branch: string;
  /**
   * カードのブランチを追う、コードのリポジトリのリモートの名前（`store.remote`、既定 `origin`）。
   * `AI_BOARD_STORE` で置き場所を差し替えても、カードのブランチはこのリモートにある
   */
  readonly branchRemote: string;
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
  const storeFromEnv = env[STORE_ENV] ?? '';

  const storeOverride = storeFromEnv !== '' ? path.resolve(storeFromEnv) : null;

  return {
    root: absoluteRoot,
    boardDir,
    sharedBoardDir,
    repoDir: path.dirname(sharedBoardDir),
    localDir:
      storeOverride !== null ? `${storeOverride}.local` : path.join(sharedBoardDir, LOCAL_DIR),
    storeOverride,
  };
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
        `[ai-board] メインのチェックアウトを求められないため、${boardDir} の下の手元のファイルを使います: ${location.reason}`
      );
      return boardDir;
  }
}

/**
 * 設定を読み込む。
 *
 * config.yaml は git に載せた `.ai-board/config.yaml`（`boardDir`）から読む。clone した時点で揃い、
 * fork では `github.repository` を書き換える。置き場所は書かなければ `origin` の `main`。
 *
 * 設定ファイルが無い、取得先のセクションが無いのいずれの場合も
 * 連携は無効になるだけでエラーにはしない。
 */
export function loadConfig(root: string, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const paths = resolvePaths(root, env);
  const configPath = path.join(paths.boardDir, CONFIG_FILE);

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

  return {
    paths,
    forge: toForgeConfig(parsed.data),
    store: {
      remote: paths.storeOverride ?? parsed.data.store?.remote ?? DEFAULT_STORE_REMOTE,
      branch: parsed.data.store?.branch ?? DEFAULT_STORE_BRANCH,
      branchRemote: branchRemoteOf(parsed.data.store?.remote),
    },
  };
}

/**
 * カードのブランチを追うリモートの名前。`store.remote` がリモートの名前ならそれ、パスや URL なら既定（`origin`）。
 * `refs/remotes/<名前>/` に埋め込むので、名前でない値は使わない
 */
function branchRemoteOf(remote: string | null | undefined): string {
  return remote !== null && remote !== undefined && isRemoteName(remote)
    ? remote
    : DEFAULT_STORE_REMOTE;
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
