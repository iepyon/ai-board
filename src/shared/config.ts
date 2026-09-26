import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

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

const GitLabConfigSchema = z.object({
  url: z.string().url(),
  projectId: z.union([z.number().int().positive(), z.string().min(1)]),
});

/** GitHub は API パスが owner/repo 固定なので数値 id を受ける意味が無い */
const GitHubConfigSchema = z.object({
  repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'repository は owner/repo の形式で書く'),
});

const ConfigFileSchema = z
  .object({
    gitlab: GitLabConfigSchema.optional(),
    github: GitHubConfigSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.gitlab !== undefined && value.github !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'gitlab と github は同時に指定できない。どちらか一方だけを書く',
      });
    }
  });

/**
 * レビュー要求の取得先。
 *
 * アクセストークンは持たない。認証は gh / glab CLI に委ねる。
 */
export type ForgeConfig =
  | { readonly kind: 'gitlab'; readonly url: string; readonly projectId: number | string }
  | { readonly kind: 'github'; readonly owner: string; readonly repo: string };

export interface BoardPaths {
  /** 対象プロジェクトのルート */
  readonly root: string;
  /** .ai-board/ */
  readonly boardDir: string;
  /** .ai-board/cards/（移行前のカードファイル。取り込み元としてだけ使う） */
  readonly cardsDir: string;
  /** .ai-board/board.db */
  readonly dbPath: string;
  /** .ai-board/plans/ */
  readonly plansDir: string;
}

export interface AppConfig {
  readonly paths: BoardPaths;
  /** 取得先が未設定なら null（ボードはカードと計画ファイルだけで動く） */
  readonly forge: ForgeConfig | null;
}

export function resolvePaths(root: string): BoardPaths {
  const absoluteRoot = path.resolve(root);
  const boardDir = path.join(absoluteRoot, BOARD_DIR);

  return {
    root: absoluteRoot,
    boardDir,
    cardsDir: path.join(boardDir, CARDS_DIR),
    dbPath: path.join(boardDir, DB_FILE),
    plansDir: path.join(boardDir, PLANS_DIR),
  };
}

/**
 * 設定を読み込む。
 *
 * 設定ファイルが無い、取得先のセクションが無いのいずれの場合も
 * 連携は無効になるだけでエラーにはしない。
 * gitlab と github が同時に書かれている場合だけは、どちらが効いているか
 * 分からないまま動かさないために例外を投げる。
 */
export function loadConfig(root: string): AppConfig {
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

  return { paths, forge: toForgeConfig(parsed.data) };
}

function toForgeConfig(data: z.infer<typeof ConfigFileSchema>): ForgeConfig | null {
  if (data.gitlab !== undefined) {
    return {
      kind: 'gitlab',
      url: data.gitlab.url.replace(/\/+$/, ''),
      projectId: data.gitlab.projectId,
    };
  }

  if (data.github !== undefined) {
    const [owner, repo] = data.github.repository.split('/');
    // スキーマの正規表現が owner/repo を保証しているが、型の上では undefined を取り得る
    if (owner !== undefined && repo !== undefined) {
      return { kind: 'github', owner, repo };
    }
  }

  return null;
}
