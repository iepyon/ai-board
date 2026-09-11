import { STAGE_LABELS, STAGE_OWNER, type BoardCard } from '../../types.js';

// ============================================================
// ステージの表示
// ============================================================

/**
 * ステージは選ぶものではなく、実態から決まるもの。
 * ここでは「今どこにいて、なぜそこにいて、どこまで動かせるか」を示す。
 */
export function StageSection({ card }: { card: BoardCard }) {
  const owner = STAGE_OWNER[card.stage];

  return (
    <>
      <h3>ステージ</h3>

      <p className="stage-now">
        <span className={`stage-chip${owner === 'ai' ? ' ai' : ''}`}>
          {STAGE_LABELS[card.stage]}
        </span>
        {owner === 'ai' && <span className="stage-owner">AI の領分</span>}
        {owner === 'human' && <span className="stage-owner">あなたの判断待ち</span>}
      </p>

      <div className="reason">{card.reason}</div>

      <p className="movable">{describeMovement(card)}</p>

      {card.aborted && <div className="divergence">このカードは中止されています。</div>}
    </>
  );
}

/** どこまで手で動かせるかを一文で説明する */
function describeMovement(card: BoardCard): string {
  if (card.droppableStages.length === 0) {
    return `${STAGE_LABELS[card.floorStage]} まで進んでいるため、手では動かせません。`;
  }

  const labels = card.droppableStages.map((stage) => STAGE_LABELS[stage]).join(' / ');

  return `手で動かせる先: ${labels}`;
}
