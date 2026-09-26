import type { BoardCard, ForgeKind } from '../types.js';

// ============================================================
// カード上のバッジ列
// ============================================================

/**
 * バッジは「その情報がどこから来たか」を色で示す。
 * 計画ファイル = 水色 / レビュー要求 = 紫 / カード自身 = 橙 / archive = 緑
 *
 * 情報源ごとに小さなコンポーネントへ分けている。1 つの関数に並べると
 * 条件が増えるたびに複雑度が上がり、どの行がどの情報源のものか読めなくなる。
 */
export function CardBadges({ card }: { card: BoardCard }) {
  return (
    <div className="badges">
      <PlanBadges card={card} />
      <ForgeBadges card={card} />
      <CardOwnBadges card={card} />
    </div>
  );
}

/** 計画ファイルの有無と archive */
function PlanBadges({ card }: { card: BoardCard }) {
  if (card.plan === null) return null;

  return card.plan.archived ? (
    <span className="badge archive">archived</span>
  ) : (
    <span className="badge plan">plan</span>
  );
}

/** 番号の書き方は取得先ごとに違う。GitLab の MR は `!1`、GitHub の PR は `#1` */
const NUMBER_PREFIX: Record<ForgeKind, string> = { gitlab: '!', github: '#' };

/** レビュー要求の状態。再提出済みは `pr` 列内での再レビュー待ちを示す */
function ForgeBadges({ card }: { card: BoardCard }) {
  if (card.mrState === null) return null;

  return (
    <>
      <span className="badge forge">
        {NUMBER_PREFIX[card.mrState.forge]}
        {card.mrState.iid} {card.mrState.state}
      </span>

      {card.mrState.resubmitted && <span className="badge forge">再提出済み</span>}
    </>
  );
}

/** カード自身が持つ情報 */
function CardOwnBadges({ card }: { card: BoardCard }) {
  return (
    <>
      {card.skipGates.length > 0 && (
        <span className="badge manual" title="人のレビューを飛ばす設定です">
          skip: {card.skipGates.join(' / ')}
        </span>
      )}

      {card.aborted && <span className="badge warn">中止</span>}
    </>
  );
}
