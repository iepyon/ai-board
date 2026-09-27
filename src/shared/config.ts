import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { locateWorktree } from './git-worktree.js';

// ============================================================
// ai-board の設定
// ============================================================

export const BOARD_DIR = '.ai-board';
/** 移行前のカードファイルの置き場所。`ai-board import` の既定の取り込み元 */
export const CARDS_DIR = 'cards';
/** カードの正本。git には載せない */
export const DB_FILE = 'board.db';
export const CONFIG_FILE = 'config.yaml';
export const PLANS_DIR = 'plans';
/** DB の場所を明示する環境変数。ワークツリーで共有の DB を使わせたくないとき（ai-board 自身の開発など）に使う */
export const DB_ENV = 'AI_BOARD_DB';

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
  /** .ai-board/cards/（移行前のカードファイル。取り込み元としてだけ使う） */
  readonly cardsDir: string;
  /**
   * git に載らない各自のファイル（DB と config.yaml）を置く .ai-board/。
   * リンクされたワークツリーではメインのチェックアウトのもの、それ以外は `boardDir` と同じ
   */
  readonly sharedBoardDir: string;
  /** board.db。既定は `sharedBoardDir` の下 */
  readonly dbPath: string;
  /** DB の場所をどう決めたか（起動ログに出す） */
  readonly dbSource: 'local' | 'main-checkout' | 'env';
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
 * DB と config.yaml は git に載らない各自のファイルなので、リンクされたワークツリーでは
 * メインのチェックアウトのものを使う。全ワークツリーで 1 つのバックログを共有するため。
 */
export function resolvePaths(root: string, env: NodeJS.ProcessEnv = process.env): BoardPaths {
  const absoluteRoot = path.resolve(root);
  const boardDir = path.join(absoluteRoot, BOARD_DIR);
  const sharedBoardDir = resolveSharedBoardDir(absoluteRoot, boardDir);
  const dbFromEnv = env[DB_ENV] ?? '';
  const shared = sharedBoardDir !== boardDir;

  return {
    root: absoluteRoot,
    boardDir,
    cardsDir: path.join(boardDir, CARDS_DIR),
    sharedBoardDir,
    dbPath: dbFromEnv !== '' ? path.resolve(dbFromEnv) : path.join(sharedBoardDir, DB_FILE),
    dbSource: dbFromEnv !== '' ? 'env' : shared ? 'main-checkout' : 'local',
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
      // ボードが開かないより、ワークツリーの下の DB で開く方が良い
      console.warn(
        `[ai-board] メインのチェックアウトを求められないため、${boardDir} の DB を使います: ${location.reason}`
      );
      return boardDir;
  }
}

/**
 * 設定を読み込む。
 *
 * 設定ファイルが無い、取得先のセクションが無いのいずれの場合も
 * 連携は無効になるだけでエラーにはしない。
 */
export function loadConfig(root: string): AppConfig {
  const paths = resolvePaths(root);
  const configPath = path.join(paths.sharedBoardDir, CONFIG_FILE);

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
