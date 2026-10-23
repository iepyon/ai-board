import { STAGE_LABELS, STAGE_OWNER, type Stage } from '../../types.js';

// ============================================================
// ステージの札
// ============================================================

/** ステージの名前の札。AI の列は色を変える。ステージの欄とタイトルの下の要約が共有する */
export function StageChip({ stage }: { stage: Stage }) {
  return (
    <span className={`stage-chip${STAGE_OWNER[stage] === 'ai' ? ' ai' : ''}`}>
      {STAGE_LABELS[stage]}
    </span>
  );
}
