import { STAGE_LABELS, STAGE_OWNER, type BoardCard } from '../../types.js';

// ============================================================
// タイトルの下の要約
// ============================================================

/**
 * ステージ・タスクの進み・PR へのリンクを 1 行で出す。
 * 本文をパネルの上に置いても、カードがどこにいるかをスクロールせずに読めるようにする。
 * 詳しい理由や紐付けの欄は本文の後ろにある。
 */
export function SummaryLine({ card }: { card: BoardCard }) {
  const tasks = card.plan?.tasks;
  const mr = card.mrState;

  return (
    <p className="detail-summary">
      <span className={`stage-chip${STAGE_OWNER[card.stage] === 'ai' ? ' ai' : ''}`}>
        {STAGE_LABELS[card.stage]}
      </span>
      {card.aborted && <span className="detail-summary-item">中止</span>}
      {tasks !== undefined && tasks.total > 0 && (
        <span className="detail-summary-item">
          タスク {tasks.completed}/{tasks.total}
        </span>
      )}
      {mr !== null && (
        <a className="detail-summary-item" href={mr.webUrl} target="_blank" rel="noreferrer">
          PR #{mr.iid} ↗{mr.draft && '（Draft）'}
        </a>
      )}
    </p>
  );
}
