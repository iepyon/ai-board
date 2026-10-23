import { StageChip } from './StageChip.js';
import type { BoardCard, BoardCardMr } from '../../types.js';

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
      <StageChip stage={card.stage} />
      {card.aborted && <span className="detail-summary-item">中止</span>}
      {tasks !== undefined && tasks.total > 0 && (
        <span className="detail-summary-item">
          タスク {tasks.completed}/{tasks.total}
        </span>
      )}
      {mr !== null && (
        <a className="detail-summary-item" href={mr.webUrl} target="_blank" rel="noreferrer">
          PR #{mr.iid} ↗{prNote(mr)}
        </a>
      )}
    </p>
  );
}

/** PR の状態の注記。開いている PR は Draft のときだけ書き、閉じた PR は開いているものと見分けが付くようにする */
function prNote(mr: BoardCardMr): string {
  switch (mr.state) {
    case 'merged':
      return '（マージ済み）';
    case 'closed':
    case 'locked':
      return '（クローズ）';
    case 'opened':
      return mr.draft ? '（Draft）' : '';
  }
}
