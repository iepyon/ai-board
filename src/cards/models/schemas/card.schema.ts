import { z } from 'zod';
import { CardIdSchema, ChangeNameSchema } from '../../../shared/schemas/common.js';
import { REVIEW_GATES, REVIEW_KINDS } from '../review.js';

const ReviewGateSchema = z.enum(REVIEW_GATES);

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
  skipGates: z.array(ReviewGateSchema).default([]),
  /** openspec の change ディレクトリ名 */
  change: nullableField(ChangeNameSchema).default(null),
  /** Git のブランチ名。MR iid の自動解決に使う */
  branch: nullableField(z.string().min(1).max(200)).default(null),
  /** GitLab MR の iid */
  mr: nullableField(z.number().int().positive()).default(null),
});

export type CardFrontmatter = z.infer<typeof CardFrontmatterSchema>;

// ============================================================
// API 入力スキーマ
// ============================================================

export const CreateCardInputSchema = z.object({
  title: z.string().min(1).max(200),
  /** 省略時は title から slug を生成する */
  id: CardIdSchema.optional(),
  body: z.string().max(100_000).optional(),
});

export type CreateCardInput = z.infer<typeof CreateCardInputSchema>;

/**
 * frontmatter の部分更新。
 * 明示的に null を送ることで「紐付けを外す」を表現できるため、
 * undefined（未指定＝変更しない）と null を区別する。
 *
 * ステージを直接指定する手段は無い。人の判断は `startedAt` の打刻と
 * 本文のレビューログにだけ現れ、そこから導出される。
 */
export const UpdateCardMetaInputSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    startedAt: z.union([IsoDateTime, z.null()]).optional(),
    skipGates: z.array(ReviewGateSchema).optional(),
    change: z.union([ChangeNameSchema, z.null()]).optional(),
    branch: z.union([z.string().min(1).max(200), z.null()]).optional(),
    mr: z.union([z.number().int().positive(), z.null()]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: '更新するフィールドを 1 つ以上指定してください',
  });

export type UpdateCardMetaInput = z.infer<typeof UpdateCardMetaInputSchema>;

export const UpdateCardBodyInputSchema = z.object({
  body: z.string().max(100_000),
});

export type UpdateCardBodyInput = z.infer<typeof UpdateCardBodyInputSchema>;

/**
 * レビューエントリの追記。
 *
 * 提出 / 再提出 は AI が書くもので、この API からは受け付けない。
 * 否決には理由文を必須にする。空の否決は AI が次の周回で読むものを持たないため。
 */
export const AppendReviewInputSchema = z
  .object({
    gate: z.enum(REVIEW_GATES),
    kind: z.enum(REVIEW_KINDS),
    reason: z.string().max(10_000).default(''),
  })
  .refine((value) => value.kind !== '否決' || value.reason.trim() !== '', {
    message: '否決には理由を書いてください',
    path: ['reason'],
  });

export type AppendReviewInput = z.infer<typeof AppendReviewInputSchema>;
