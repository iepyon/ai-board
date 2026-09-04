import { z } from 'zod';
import { CardIdSchema, ChangeNameSchema, StageSchema } from '../../../shared/schemas/common.js';

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
  /** explored ステージへ昇格させる明示フラグ */
  explored: z.boolean().default(false),
  /** impling ステージへ昇格させる明示マーカー（打刻時刻） */
  implStartedAt: nullableField(IsoDateTime).default(null),
  /** openspec の change ディレクトリ名 */
  change: nullableField(ChangeNameSchema).default(null),
  /** Git のブランチ名。MR iid の自動解決に使う */
  branch: nullableField(z.string().min(1).max(200)).default(null),
  /** GitLab MR の iid */
  mr: nullableField(z.number().int().positive()).default(null),
  /** ステージの手動上書き。null なら自動導出 */
  stageOverride: nullableField(StageSchema).default(null),
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
 * `stageOverride` は null（解除）しか受け付けない。ステージは実態から
 * 導出するものであり、ツール自身が実態と食い違う値を書かないため。
 * 手で書かれた上書きは読み取り側では尊重する。
 */
export const UpdateCardMetaInputSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    explored: z.boolean().optional(),
    implStartedAt: z.union([IsoDateTime, z.null()]).optional(),
    change: z.union([ChangeNameSchema, z.null()]).optional(),
    branch: z.union([z.string().min(1).max(200), z.null()]).optional(),
    mr: z.union([z.number().int().positive(), z.null()]).optional(),
    stageOverride: z
      .null({
        message:
          'ステージは実態から導出されます。手動での指定はできません（null を送ると上書きを解除できます）',
      })
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: '更新するフィールドを 1 つ以上指定してください',
  });

export type UpdateCardMetaInput = z.infer<typeof UpdateCardMetaInputSchema>;

export const UpdateCardBodyInputSchema = z.object({
  body: z.string().max(100_000),
});

export type UpdateCardBodyInput = z.infer<typeof UpdateCardBodyInputSchema>;
