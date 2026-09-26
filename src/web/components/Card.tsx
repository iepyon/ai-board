import type { DragEvent } from 'react';
import { CardBadges } from './CardBadges.js';
import type { BoardCard } from '../types.js';

// ============================================================
// カンバンのカード
// ============================================================

interface CardProps {
  card: BoardCard;
  selected: boolean;
  onSelect: (card: BoardCard) => void;
  onDragStart: (card: BoardCard) => void;
  onDragEnd: () => void;
}

export function Card({ card, selected, onSelect, onDragStart, onDragEnd }: CardProps) {
  const handleDragStart = (event: DragEvent<HTMLDivElement>): void => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.id);
    onDragStart(card);
  };

  const tasks = card.plan?.tasks;

  // AI の成果物で位置が決まるカードは掴めない
  const movable = card.droppableStages.length > 0;

  return (
    <div
      className={`card${selected ? ' selected' : ''}${movable ? '' : ' pinned'}`}
      draggable={movable}
      role="button"
      tabIndex={0}
      title={movable ? card.reason : `${card.reason}（AI の領分のため手では動かせません）`}
      onClick={() => onSelect(card)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(card);
        }
      }}
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
    >
      <div className="title">{card.title}</div>

      <CardBadges card={card} />

      {tasks !== undefined && tasks.total > 0 && (
        <Progress completed={tasks.completed} total={tasks.total} />
      )}
    </div>
  );
}

function Progress({ completed, total }: { completed: number; total: number }) {
  return (
    <div className="progress">
      <div className="label">
        <span>tasks</span>
        <span>
          {completed}/{total}
        </span>
      </div>
      <div className="bar">
        <div className="fill" style={{ width: `${Math.round((completed / total) * 100)}%` }} />
      </div>
    </div>
  );
}
