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
/** 置き場所の写し・送る箱・ロック・使い捨ての控えを置くディレクトリ（`sharedBoardDir` の下） */
export const STORE_DIR = 'store';
/**
 * 置き場所のディレクトリの代わりに使うディレクトリを明示する環境変数。
 * ワークツリーで共有のカードを汚さずに試すときに使う（送る箱は送らなければ置き場所に届かない）
 */
export const STORE_ENV = 'AI_BOARD_STORE';

/** GitHub は API パスが owner/repo 固定なので数値 id を受ける意味が無い */
const GitHubConfigSchema = z.object({
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'repository は owner/repo の形式で書く'),
});

/** 置き場所。今は Artifact の DB だけで、URL はボードのページの Artifact */
const StoreConfigSchema = z.object({
  url: z
    .string()
    .regex(
      /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+$/,
      'store.url には claude.ai の Artifact の URL を書く'
    )
    .nullable()
    .optional(),
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
   * git に載らない各自のファイル（置き場所の写しと送る箱）を置く .ai-board/。
   * リンクされたワークツリーではメインのチェックアウトのもの、それ以外は `boardDir` と同じ
   */
  readonly sharedBoardDir: string;
  /** 置き場所の写し・送る箱のディレクトリ。既定は `sharedBoardDir` の下の store/ */
  readonly storeDir: string;
  /** 置き場所のディレクトリをどう決めたか */
  readonly storeSource: 'local' | 'main-checkout' | 'env';
  /** .ai-board/plans/（git でブランチに乗るので、常に `root` の下） */
  readonly plansDir: string;
}

export interface AppConfig {
  readonly paths: BoardPaths;
  /** 取得先が未設定なら null（ボードはカードと計画ファイルだけで動く） */
  readonly forge: ForgeConfig | null;
  /** 置き場所の Artifact の URL。未設定なら null */
  readonly storeUrl: string | null;
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
  const sharedSource = sharedBoardDir !== boardDir ? 'main-checkout' : 'local';

  const storeDir =
    storeFromEnv !== '' ? path.resolve(storeFromEnv) : path.join(sharedBoardDir, STORE_DIR);

  return {
    root: absoluteRoot,
    boardDir,
    sharedBoardDir,
    storeDir,
    storeSource: storeFromEnv !== '' ? 'env' : sharedSource,
    plansDir: path.join(boardDir, PLANS_DIR),
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
        `[ai-board] メインのチェックアウトを求められないため、${boardDir} の下の写しを使います: ${location.reason}`
      );
      return boardDir;
  }
}

/**
 * 設定を読み込む。
 *
 * config.yaml は git に載せた `.ai-board/config.yaml`（`boardDir`）から読む。clone した時点で揃い、
 * fork では `github.repository` と `store.url` の 2 行を書き換える。
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

  return { paths, forge: toForgeConfig(parsed.data), storeUrl: parsed.data.store?.url ?? null };
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
