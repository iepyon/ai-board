import { SECTION_OF_STAGE, type DashboardSection } from '../../../shared/dashboard-sections.js';
import {
  STAGE_LABELS,
  STAGE_OWNER,
  STAGE_SOURCE,
  type BoardCard,
  type Stage,
} from '../../types.js';

// ============================================================
// ステージ別の件数帯
// ============================================================

const OWNER_LABELS: Record<'human' | 'ai' | 'none', string> = {
  human: '人',
  ai: 'AI',
  none: '—',
};

/** 人の判断を待つゲートの列。件数があれば目立たせる */
const GATE_STAGES: readonly Stage[] = ['plan-review', 'pr'];

export function sectionAnchor(section: DashboardSection): string {
  return `sec-${section}`;
}

interface PipelineStripProps {
  stages: readonly Stage[];
  /** 中止を除いたカード。中止は工程の外にあるので件数に数えない */
  cards: readonly BoardCard[];
}

/**
 * 6 段の件数。下線の色は、そのステージを立てる情報源（カード / 計画 / PR / archive）を表す。
 * 詳細パネルやステージの札の色と同じ意味を持たせている。
 */
export function PipelineStrip({ stages, cards }: PipelineStripProps) {
  return (
    <nav className="pipe" aria-label="ステージ別の件数">
      {stages.map((stage) => {
        const count = cards.filter((card) => card.stage === stage).length;
        const gate = GATE_STAGES.includes(stage);
        const hot = gate && count > 0;

        return (
          <a
            key={stage}
            href={`#${sectionAnchor(SECTION_OF_STAGE[stage])}`}
            className={`pipe-cell src-${STAGE_SOURCE[stage]}${hot ? ' hot' : ''}`}
          >
            <span className="lbl">
              {STAGE_LABELS[stage]}
              {gate && ' ★'}
            </span>
            <span className="row">
              <span className="n">{count}</span>
              <span className="who">{gate ? '人が判断' : OWNER_LABELS[STAGE_OWNER[stage]]}</span>
            </span>
          </a>
        );
      })}
    </nav>
  );
}
