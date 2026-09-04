import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// ============================================================
// ai-board の設定
// ============================================================

export const BOARD_DIR = '.ai-board';
export const CARDS_DIR = 'cards';
export const CONFIG_FILE = 'config.yaml';
export const OPENSPEC_DIR = 'openspec';

/** GitLab トークンは設定ファイルではなく環境変数からのみ読む */
export const GITLAB_TOKEN_ENV = 'AI_BOARD_GITLAB_TOKEN';

const GitLabConfigSchema = z.object({
  url: z.string().url(),
  projectId: z.union([z.number().int().positive(), z.string().min(1)]),
});

const ConfigFileSchema = z.object({
  gitlab: GitLabConfigSchema.optional(),
});

export type GitLabConfig = z.infer<typeof GitLabConfigSchema> & {
  /** 環境変数から読んだトークン。ブラウザには決して返さない */
  readonly token: string;
};

export interface BoardPaths {
  /** 対象プロジェクトのルート */
  readonly root: string;
  /** .ai-board/ */
  readonly boardDir: string;
  /** .ai-board/cards/ */
  readonly cardsDir: string;
  /** openspec/ */
  readonly openspecDir: string;
}

export interface AppConfig {
  readonly paths: BoardPaths;
  /** GitLab 未設定・トークン未設定なら null（ボードは openspec 由来の情報だけで動く） */
  readonly gitlab: GitLabConfig | null;
}

export function resolvePaths(root: string): BoardPaths {
  const absoluteRoot = path.resolve(root);
  const boardDir = path.join(absoluteRoot, BOARD_DIR);

  return {
    root: absoluteRoot,
    boardDir,
    cardsDir: path.join(boardDir, CARDS_DIR),
    openspecDir: path.join(absoluteRoot, OPENSPEC_DIR),
  };
}

/**
 * 設定を読み込む。
 *
 * 設定ファイルが無い、gitlab セクションが無い、トークンが未設定の
 * いずれの場合も GitLab 連携は無効になるだけでエラーにはしない。
 */
export function loadConfig(root: string, env: NodeJS.ProcessEnv = process.env): AppConfig {
  const paths = resolvePaths(root);
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

  const token = env[GITLAB_TOKEN_ENV];
  const gitlabSection = parsed.data.gitlab;

  const gitlab: GitLabConfig | null =
    gitlabSection && token
      ? { url: gitlabSection.url.replace(/\/+$/, ''), projectId: gitlabSection.projectId, token }
      : null;

  return { paths, gitlab };
}
