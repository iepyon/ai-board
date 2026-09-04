import { useState } from 'react';
import { Column } from './Column.js';
import { updateCardMeta, type CardMetaPatch } from '../api.js';
import type { Board as BoardData, BoardCard, Stage } from '../types.js';

// ============================================================
// 7 列のカンバン
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
 */
function patchForStage(stage: Stage): CardMetaPatch | null {
  switch (stage) {
    case 'idea':
      return { explored: false, implStartedAt: null };
    case 'explored':
      return { explored: true, implStartedAt: null };
    case 'impling':
      return { implStartedAt: new Date().toISOString() };
    default:
      // AI の成果物から導出される列。人は動かせない
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

    // 手書きの上書きが残っていると自動導出に勝ってしまい、
    // フラグを書いてもカードが動かない。ドラッグは「ここに置く」という
    // 明示の意思表示なので、あわせて上書きを外す。
    const withOverrideCleared: CardMetaPatch = card.overridden
      ? { ...patch, stageOverride: null }
      : patch;

    updateCardMeta(card.id, withOverrideCleared)
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
