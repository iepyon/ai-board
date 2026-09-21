import type { BoardCard, ForgeKind } from '../types.js';

// ============================================================
// カード上のバッジ列
// ============================================================

/**
 * バッジは「その情報がどこから来たか」を色で示す。
 * openspec = 水色 / レビュー要求 = 紫 / カードファイル = 橙 / archive = 緑
 *
 * 情報源ごとに小さなコンポーネントへ分けている。1 つの関数に並べると
 * 条件が増えるたびに複雑度が上がり、どの行がどの情報源のものか読めなくなる。
 */
export function CardBadges({ card }: { card: BoardCard }) {
  return (
    <div className="badges">
      <OpenSpecBadges card={card} />
      <ForgeBadges card={card} />
      <CardFileBadges card={card} />
    </div>
  );
}

/** openspec の change と archive */
function OpenSpecBadges({ card }: { card: BoardCard }) {
  return (
    <>
      {card.openspec !== null && !card.openspec.archived && (
        <span className="badge openspec">{card.openspec.change}</span>
      )}

      {card.openspec?.archived === true && (
        <span className="badge archive">archived {archiveDate(card.openspec.archivedAs)}</span>
      )}

      {/* 紐付けた change が openspec 側に見つからない＝名前のずれ */}
      {card.change !== null && card.openspec === null && (
        <span className="badge warn">change 未検出</span>
      )}
    </>
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

/** カードファイル自身が持つ情報 */
function CardFileBadges({ card }: { card: BoardCard }) {
  return (
    <>
      {card.skipGates.length > 0 && (
        <span className="badge manual" title="人のレビューを飛ばす設定です">
          skip: {card.skipGates.join(' / ')}
        </span>
      )}

      {card.aborted && <span className="badge warn">中止</span>}

      {card.stage === 'idea' && card.change === null && (
        <span className="badge manual">card only</span>
      )}
    </>
  );
}

/** `2026-09-01-refresh-token` から月日だけを取り出す */
function archiveDate(archivedAs: string | null): string {
  const match = archivedAs?.match(/^\d{4}-(\d{2})-(\d{2})-/);
  return match === null || match === undefined ? '' : `${match[1]}-${match[2]}`;
}
