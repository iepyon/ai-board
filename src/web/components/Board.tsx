import { useState } from 'react';
import { Column } from './Column.js';
import { updateCardMeta, type CardMetaPatch } from '../api.js';
import type { Board as BoardData, BoardCard, Stage } from '../types.js';

// ============================================================
// 9 列のカンバン
// ============================================================

interface BoardProps {
  board: BoardData;
  selectedId: string | null;
  onSelect: (card: BoardCard) => void;
  onChanged: () => void;
  onAddCard: () => void;
  onError: (message: string) => void;
}

/**
 * ドロップ先の列に応じて書き込むフラグ。
 *
 * ステージを直接指定するのではなく、その列を成立させる実フラグを書く。
 * これにより「ボードには出ているが実態は違う」状態が生まれない。
 *
 * 人がドラッグで動かせるのは着手の 1 遷移だけ。
 * 承認 / 否決 / 中止 はドラッグではなく詳細パネルのボタンで行う。
 */
function patchForStage(stage: Stage): CardMetaPatch | null {
  switch (stage) {
    case 'idea':
      return { startedAt: null };
    case 'exploring':
      return { startedAt: new Date().toISOString() };
    default:
      // AI の成果物かレビューログから導出される列。ドラッグでは着地できない
      return null;
  }
}

export function Board({ board, selectedId, onSelect, onChanged, onAddCard, onError }: BoardProps) {
  const [dragging, setDragging] = useState<BoardCard | null>(null);

  const handleDrop = (stage: Stage): void => {
    const card = dragging;
    setDragging(null);

    if (card === null || card.stage === stage) return;
    if (!card.droppableStages.includes(stage)) return;

    const patch = patchForStage(stage);
    if (patch === null) return;

    updateCardMeta(card.id, patch)
      .then(onChanged)
      .catch((cause: unknown) => {
        onError(cause instanceof Error ? cause.message : String(cause));
      });
  };

  return (
    <div className="board">
      {board.stages.map((stage) => (
        <Column
          key={stage}
          stage={stage}
          cards={board.cards.filter((card) => card.stage === stage)}
          selectedId={selectedId}
          dragging={dragging}
          onSelect={onSelect}
          onDragStart={setDragging}
          onDragEnd={() => setDragging(null)}
          onDrop={handleDrop}
          onAdd={stage === 'idea' ? onAddCard : undefined}
        />
      ))}
    </div>
  );
}
