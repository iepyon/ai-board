import { z } from 'zod';
import { CardIdSchema } from '../../../shared/schemas/common.js';
import { isRetiredReviewGate, REVIEW_GATES } from '../review.js';

const ReviewGateSchema = z.enum(REVIEW_GATES);

/**
 * frontmatter の `skipGates`。廃止したゲート（`RETIRED_REVIEW_GATES`）を落としてから検証する。
 *
 * 廃止したゲートの `## レビュー` のエントリは規定外として黙って無視する（`review.ts`）。
 * `skipGates` は Zod で検証するので、落とさないとマージ済みのカードまで読めなくなる。
 * 落とすのは廃止したものだけにし、書き損じは今までどおり検証で落とす。書く入口（`PATCH`）は受け付けない。
 */
const StoredSkipGatesSchema = z.preprocess(
  (value) =>
    Array.isArray(value)
      ? value.filter((gate) => typeof gate !== 'string' || !isRetiredReviewGate(gate))
      : value,
  z.array(ReviewGateSchema)
);

// ============================================================
// カード frontmatter のスキーマ
// ============================================================

/**
 * YAML パーサは ISO 8601 に見える値を Date に変換してしまうため、
 * 日時は Date と string の両方を受けて ISO 文字列に正規化する。
 */
const IsoDateTime = z
  .union([z.string(), z.date()])
  .transform((value) => (value instanceof Date ? value.toISOString() : value))
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: '日時は ISO 8601 形式で指定してください',
  });

/** null と undefined と空文字をすべて「未設定」として扱う */
function nullableField<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess(
    (value) => (value === undefined || value === '' ? null : value),
    z.union([schema, z.null()])
  );
}

export const CardFrontmatterSchema = z.object({
  id: CardIdSchema,
  title: z.string().min(1).max(200),
  created: IsoDateTime,
  /** 人が探索の着手を指示した時刻 */
  startedAt: nullableField(IsoDateTime).default(null),
  /** 人が事前に見ないと宣言したゲート */
  skipGates: StoredSkipGatesSchema.default([]),
  /** Git のブランチ名。PR 番号の自動解決に使う */
  branch: nullableField(z.string().min(1).max(200)).default(null),
  /** レビュー要求の識別番号（GitHub の PR number） */
  mr: nullableField(z.number().int().positive()).default(null),
  /** 並び順。無ければ created から補う */
  rank: nullableField(z.number().finite()).default(null),
});

export type CardFrontmatter = z.infer<typeof CardFrontmatterSchema>;
