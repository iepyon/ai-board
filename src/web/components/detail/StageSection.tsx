import { STAGE_LABELS, isHumanStage, type BoardCard } from '../../types.js';
import type { CardMetaPatch } from '../../api.js';

// ============================================================
// ステージの表示
// ============================================================

interface StageSectionProps {
  card: BoardCard;
  saving: boolean;
  onPatch: (patch: CardMetaPatch) => void;
}

/**
 * ステージは選ぶものではなく、実態から決まるもの。
 * ここでは「今どこにいて、なぜそこにいて、どこまで動かせるか」を示す。
 */
export function StageSection({ card, saving, onPatch }: StageSectionProps) {
  return (
    <>
      <h3>ステージ</h3>

      <p className="stage-now">
        <span className={`stage-chip${isHumanStage(card.stage) ? '' : ' ai'}`}>
          {STAGE_LABELS[card.stage]}
        </span>
        {!isHumanStage(card.stage) && <span className="stage-owner">AI の領分</span>}
      </p>

      <div className="reason">{card.reason}</div>

      <p className="movable">{describeMovement(card)}</p>

      {card.overridden && (
        <div className="divergence">
          このカードには手書きの上書き（<code>stageOverride: {card.stageOverride}</code>
          ）があります。
          {card.diverged && <> 実態は {STAGE_LABELS[card.derivedStage]} です。</>}
          <div className="actions">
            <button
              type="button"
              className="btn ghost"
              disabled={saving}
              onClick={() => onPatch({ stageOverride: null })}
            >
              この上書きを解除する
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** どこまで手で動かせるかを一文で説明する */
function describeMovement(card: BoardCard): string {
  if (card.droppableStages.length === 0) {
    return `${STAGE_LABELS[card.floorStage]} 以降は AI の成果物で決まります。手では動かせません。`;
  }

  const labels = card.droppableStages.map((stage) => STAGE_LABELS[stage]).join(' / ');

  if (card.floorStage === 'idea') {
    return `手で動かせる先: ${labels}`;
  }

  return `${STAGE_LABELS[card.floorStage]} まで進んでいるため、手で動かせる先は ${labels} だけです。`;
}
