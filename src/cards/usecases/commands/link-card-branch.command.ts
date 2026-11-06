import type { Result } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import type { Card } from '../../models/card.js';
import type { UpdateCardError } from '../../errors/card-errors.js';
import type { UpdateCardMetaCommand } from './update-card-meta.command.js';

// ============================================================
// ブランチの紐付けユースケース
// ============================================================

export interface LinkCardBranchInput {
  readonly id: CardId;
  /** 紐付けるブランチの名前。null なら紐付けを外す */
  readonly branch: string | null;
}

export type LinkCardBranchCommand = (
  input: LinkCardBranchInput
) => Promise<Result<Card, UpdateCardError>>;

/**
 * カードの `branch` だけを書き換える。AI が書いてよい frontmatter の項目はこれだけで、
 * 入力が `branch` しか持たないので、`startedAt` / `skipGates`（人の判断）はこの口からは書けない。
 * 読み書きは frontmatter の部分更新（`updateCardMetaCommand`）に任せる。
 */
export function createLinkCardBranchCommand(
  updateCardMetaCommand: UpdateCardMetaCommand
): LinkCardBranchCommand {
  return ({ id, branch }) => updateCardMetaCommand({ id, patch: { branch } });
}
