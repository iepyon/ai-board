import { useState, type DragEvent } from 'react';
import { Card } from './Card.js';
import { STAGE_LABELS, STAGE_SOURCE, isHumanStage, type BoardCard, type Stage } from '../types.js';

// ============================================================
// カンバンの 1 列
// ============================================================

const SOURCE_COLORS: Record<string, string> = {
  card: 'var(--src-card)',
  openspec: 'var(--src-openspec)',
  gitlab: 'var(--src-gitlab)',
  archive: 'var(--src-archive)',
};

interface ColumnProps {
  stage: Stage;
  cards: readonly BoardCard[];
  selectedId: string | null;
  /** ドラッグ中のカード。この列が受け入れられるかの判定に使う */
  dragging: BoardCard | null;
  onSelect: (card: BoardCard) => void;
  onDragStart: (card: BoardCard) => void;
  onDragEnd: () => void;
  onDrop: (stage: Stage) => void;
  onAdd?: (() => void) | undefined;
}

export function Column({
  stage,
  cards,
  selectedId,
  dragging,
  onSelect,
  onDragStart,
  onDragEnd,
  onDrop,
  onAdd,
}: ColumnProps) {
  const [dragOver, setDragOver] = useState(false);

  const accepts = dragging !== null && dragging.droppableStages.includes(stage);
  const rejects = dragging !== null && !accepts && dragging.stage !== stage;

  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.dataTransfer.dropEffect = accepts ? 'move' : 'none';
    if (accepts) setDragOver(true);
  };

  const className = ['column', dragOver && accepts ? 'dragover' : '', rejects ? 'rejects' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      onDragOver={handleDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragOver(false);
        if (accepts) onDrop(stage);
      }}
    >
      <div
        className="column-head"
        style={{ ['--source-color' as string]: SOURCE_COLORS[STAGE_SOURCE[stage]] }}
      >
        <span className="name">
          {STAGE_LABELS[stage]}
          {!isHumanStage(stage) && (
            <span className="lock" title="AI の成果物から自動で決まる列です。手では動かせません">
              🔒
            </span>
          )}
        </span>
        <span className="count">{cards.length}</span>
      </div>

      <div className="column-cards">
        {cards.map((card) => (
          <Card
            key={card.id}
            card={card}
            selected={card.id === selectedId}
            onSelect={onSelect}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}

        {onAdd !== undefined && (
          <button type="button" className="add-card" onClick={onAdd}>
            ＋ アイデアを追加
          </button>
        )}
      </div>
    </div>
  );
}
