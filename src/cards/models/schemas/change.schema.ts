import { z } from 'zod';
import { CardIdSchema } from '../../../shared/schemas/common.js';
import { REVIEW_GATES } from '../review.js';
import { IsoDateTime } from './card.schema.js';

// ============================================================
// 変更ファイル（`.ai-board/changes/*.yaml`）のスキーマ
// ============================================================

/** 値を消す `null` を受ける列。キーが無ければ「変えない」 */
function clearable<T extends z.ZodTypeAny>(schema: T) {
  return z.union([schema, z.null()]).optional();
}

/**
 * カードに書く列。列の名前と値の検証はカードの Markdown 表現（`CardFrontmatterSchema`）に揃える。
 * 知らない列はエラーにする。黙って捨てると、書いたはずの変更が消える。
 */
const CardFieldChangesSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    created: IsoDateTime.optional(),
    startedAt: clearable(IsoDateTime),
    skipGates: z.array(z.enum(REVIEW_GATES)).optional(),
    branch: clearable(z.string().min(1).max(200)),
    mr: clearable(z.number().int().positive()),
    rank: clearable(z.number().finite()),
    body: z.string().max(100_000).optional(),
  })
  .strict();

const CardOpSchema = z.object({ card: CardIdSchema, set: CardFieldChangesSchema }).strict();

const DividerOpSchema = z.object({ divider: z.number().finite() }).strict();

export const ChangeFileSchema = z.array(z.union([CardOpSchema, DividerOpSchema]));

export type ChangeFileContent = z.infer<typeof ChangeFileSchema>;
