import type { ReactNode } from 'react';
import {
  GATE_STAGES,
  STAGE_LABELS,
  STAGE_SOURCE,
  type BoardCard,
  type Stage,
} from '../../types.js';
import { hasRunningStep } from '../../../shared/loop-activity.js';

// ============================================================
// 区画をまたいで使う小さな部品
// ============================================================

/** ステージの札。色はそのステージを立てる情報源 */
export function StagePill({ stage }: { stage: Stage }) {
  const gate = GATE_STAGES.includes(stage);

  return (
    <span className={`pill s-${STAGE_SOURCE[stage]}`}>
      {STAGE_LABELS[stage]}
      {gate && ' ★'}
    </span>
  );
}

/**
 * カードのタイトル。押すと詳細パネル（本文の編集・紐付け）が開く。
 * ループが今このカードを触っていれば、横に「AI 稼働中」の印を付ける
 */
export function CardTitle({
  card,
  onSelect,
}: {
  card: BoardCard;
  onSelect: (card: BoardCard) => void;
}) {
  return (
    <>
      <button type="button" className="card-title" onClick={() => onSelect(card)}>
        {card.title}
      </button>
      {hasRunningStep(card.loopSteps) && <RunningBadge />}
    </>
  );
}

/** ループが今触っているカードの印 */
export function RunningBadge() {
  return (
    <span className="loop-badge" title="ループがこのカードの手を進めています">
      AI 稼働中
    </span>
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
