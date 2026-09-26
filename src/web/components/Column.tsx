import { Fragment, useState, type DragEvent } from 'react';
import { Card } from './Card.js';
import { moveTargetFor, type MoveTarget } from '../../shared/card-reorder.js';
import { STAGE_LABELS, STAGE_OWNER, STAGE_SOURCE, type BoardCard, type Stage } from '../types.js';

// ============================================================
// カンバンの 1 列
// ============================================================

/** 列見出しに出す印。次に動くのが誰かを示す */
const OWNER_MARK: Record<'human' | 'ai' | 'none', { icon: string; title: string } | null> = {
  human: { icon: '★', title: 'あなたの判断を待っています' },
  ai: { icon: '🤖', title: 'AI が進めます。手では動かせません' },
  none: null,
};

const SOURCE_COLORS: Record<string, string> = {
  card: 'var(--src-card)',
  plan: 'var(--src-plan)',
  forge: 'var(--src-forge)',
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
  /** 同じ列の中へ落としたとき。隣のカードを渡す */
  onReorder: (card: BoardCard, target: MoveTarget) => void;
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
  onReorder,
  onAdd,
}: ColumnProps) {
  const [dragOver, setDragOver] = useState(false);
  /** 並べ替え中の挿入位置（動かす前の並びでの添字） */
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const mark = OWNER_MARK[STAGE_OWNER[stage]];

  const mode = dropModeFor(dragging, stage);
  const target = mode === 'reorder' ? reorderTarget(cards, dragging, dropIndex) : null;
  /** 挿入位置の線を出す添字。並びが変わらない位置では出さない */
  const lineAt = target !== null ? dropIndex : null;

  const handleDragOver = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.dataTransfer.dropEffect = mode === 'reject' ? 'none' : 'move';

    if (mode === 'reorder') setDropIndex(dropIndexAt(event.currentTarget, event.clientY));
    if (mode === 'accept') setDragOver(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    // 列の中の子要素へ移っただけなら離れていない
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragOver(false);
    setDropIndex(null);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragOver(false);
    setDropIndex(null);

    if (dragging !== null && target !== null) onReorder(dragging, target);
    if (mode === 'accept') onDrop(stage);
  };

  const className = [
    'column',
    dragOver && mode === 'accept' ? 'dragover' : '',
    mode === 'reject' ? 'rejects' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={className}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className="column-head"
        style={{ ['--source-color' as string]: SOURCE_COLORS[STAGE_SOURCE[stage]] }}
      >
        <span className="name">
          {STAGE_LABELS[stage]}
          {mark !== null && (
            <span className="owner" title={mark.title}>
              {mark.icon}
            </span>
          )}
        </span>
        <span className="count">{cards.length}</span>
      </div>

      <div className="column-cards">
        {cards.map((card, index) => (
          <Fragment key={card.id}>
            {lineAt === index && <div className="drop-line" />}
            <Card
              card={card}
              selected={card.id === selectedId}
              onSelect={onSelect}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          </Fragment>
        ))}

        {lineAt === cards.length && <div className="drop-line" />}

        {onAdd !== undefined && (
          <button type="button" className="add-card" onClick={onAdd}>
            ＋ アイデアを追加
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * ドラッグ中のカードをこの列がどう扱うか。
 *
 * 同じ列へのドラッグは並べ替えで、ステージは変わらないので AI の列でも受ける。
 * 別の列へは `droppableStages`（人が動かせる 1 遷移）に載っているときだけ受ける。
 */
type DropMode = 'reorder' | 'accept' | 'reject' | null;

function dropModeFor(dragging: BoardCard | null, stage: Stage): DropMode {
  if (dragging === null) return null;
  if (dragging.stage === stage) return 'reorder';
  return dragging.droppableStages.includes(stage) ? 'accept' : 'reject';
}

function reorderTarget(
  cards: readonly BoardCard[],
  dragging: BoardCard | null,
  dropIndex: number | null
): MoveTarget | null {
  if (dragging === null || dropIndex === null) return null;
  return moveTargetFor(
    cards.map((card) => card.id),
    dragging.id,
    dropIndex
  );
}

/** ポインタの Y より上に中心があるカードの枚数＝挿入位置 */
function dropIndexAt(column: HTMLElement, clientY: number): number {
  const cards = column.querySelectorAll<HTMLElement>('[data-card-id]');
  let index = 0;

  cards.forEach((card) => {
    const rect = card.getBoundingClientRect();
    if (rect.top + rect.height / 2 < clientY) index += 1;
  });

  return index;
}
