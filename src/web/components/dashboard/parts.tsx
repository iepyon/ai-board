import type { ReactNode } from 'react';
import { STAGE_LABELS, STAGE_SOURCE, type BoardCard, type Stage } from '../../types.js';

// ============================================================
// 区画をまたいで使う小さな部品
// ============================================================

/** ステージの札。色はそのステージを立てる情報源 */
export function StagePill({ stage }: { stage: Stage }) {
  const gate = stage === 'plan-review' || stage === 'pr';

  return (
    <span className={`pill s-${STAGE_SOURCE[stage]}`}>
      {STAGE_LABELS[stage]}
      {gate && ' ★'}
    </span>
  );
}

/** カードのタイトル。押すと詳細パネル（本文の編集・紐付け）が開く */
export function CardTitle({
  card,
  onSelect,
}: {
  card: BoardCard;
  onSelect: (card: BoardCard) => void;
}) {
  return (
    <button type="button" className="card-title" onClick={() => onSelect(card)}>
      {card.title}
    </button>
  );
}

export function Progress({ completed, total }: { completed: number; total: number }) {
  const percent = total === 0 ? 0 : Math.round((completed / total) * 100);

  return (
    <div className="bar" role="progressbar" aria-valuenow={completed} aria-valuemax={total}>
      <i style={{ width: `${percent}%` }} />
    </div>
  );
}

interface SectionHeadProps {
  title: string;
  count: number;
  hint?: string | undefined;
  children?: ReactNode;
}

export function SectionHead({ title, count, hint, children }: SectionHeadProps) {
  return (
    <div className="sec-h">
      <h2>{title}</h2>
      <span className="count">{count} 件</span>
      {hint !== undefined && <span className="hint">{hint}</span>}
      {children}
    </div>
  );
}
