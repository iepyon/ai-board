import { STAGE_LABELS, type BoardCard } from '../types.js';

// ============================================================
// カード上のバッジ列
// ============================================================

/**
 * バッジは「その情報がどこから来たか」を色で示す。
 * openspec = 水色 / GitLab = 紫 / カードファイル = 橙 / archive = 緑
 */
export function CardBadges({ card }: { card: BoardCard }) {
  return (
    <div className="badges">
      {card.openspec !== null && !card.openspec.archived && (
        <span className="badge openspec">{card.openspec.change}</span>
      )}

      {card.openspec?.archived === true && (
        <span className="badge archive">archived {archiveDate(card.openspec.archivedAs)}</span>
      )}

      {card.mrState !== null && (
        <span className="badge gitlab">
          !{card.mrState.iid} {card.mrState.state}
        </span>
      )}

      {/* 紐付けた change が openspec 側に見つからない＝名前のずれ */}
      {card.change !== null && card.openspec === null && (
        <span className="badge warn">change 未検出</span>
      )}

      {card.stage === 'impling' && <span className="badge manual">実装中</span>}

      {card.stage === 'idea' && card.change === null && (
        <span className="badge manual">card only</span>
      )}

      {card.diverged && (
        <span className="badge warn">⚠ 実態は {STAGE_LABELS[card.derivedStage]}</span>
      )}
    </div>
  );
}

/** `2026-09-01-refresh-token` から月日だけを取り出す */
function archiveDate(archivedAs: string | null): string {
  const match = archivedAs?.match(/^\d{4}-(\d{2})-(\d{2})-/);
  return match === null || match === undefined ? '' : `${match[1]}-${match[2]}`;
}
