import { z } from 'zod';

// ============================================================
// Branded Types — 型レベルで取り違えを防ぐ ID / 名前
// ============================================================

export type Brand<T, B extends string> = T & { readonly __brand: B };

/** カードの不変 ID（ファイル名と一致する kebab-case） */
export type CardId = Brand<string, 'CardId'>;

/** GitHub の PR number */
export type MergeRequestIid = Brand<number, 'MergeRequestIid'>;

// ============================================================
// ステージ
// ============================================================

/**
 * カードが取りうる 6 つのステージ。
 * 配列の順序がそのまま「進行度」を表し、UI の列順にも使う。
 *
 * `plan-review` / `pr` は人の判断を待つ HIL ゲート、
 * `planning` / `impling` は AI が自走する列。
 */
export const STAGES = ['idea', 'planning', 'plan-review', 'impling', 'pr', 'merged'] as const;

export const StageSchema = z.enum(STAGES);

export type Stage = z.infer<typeof StageSchema>;

/** ステージの進行度（大きいほど後段）。導出ロジックの優先順位比較に使う */
export function stageRank(stage: Stage): number {
  return STAGES.indexOf(stage);
}

// ============================================================
// ID ファクトリ / バリデータ
// ============================================================

/** kebab-case の slug。ファイル名として安全な文字だけを許す */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const CardIdSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(SLUG_PATTERN, 'id は kebab-case（英小文字・数字・ハイフン）で指定してください');

export function createCardId(raw: string): CardId {
  return CardIdSchema.parse(raw) as CardId;
}

export function createMergeRequestIid(raw: number): MergeRequestIid {
  return z.number().int().positive().parse(raw) as MergeRequestIid;
}

/**
 * 任意の文字列（日本語を含むタイトル等）から kebab-case の slug を作る。
 * 英数字が 1 文字も残らない場合は呼び出し側でフォールバックする必要があるため
 * null を返す。
 */
export function slugify(raw: string): string | null {
  const slug = raw
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');

  return slug.length > 0 ? slug : null;
}
