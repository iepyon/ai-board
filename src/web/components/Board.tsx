import { useState } from 'react';
import { Column } from './Column.js';
import { moveCard, updateCardMeta, type CardMetaPatch } from '../api.js';
import { applyMove, type MoveTarget } from '../../shared/card-reorder.js';
import type { Board as BoardData, BoardCard, Stage } from '../types.js';

// ============================================================
// 6 列のカンバン
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
    case 'planning':
      return { startedAt: new Date().toISOString() };
    default:
      // AI の成果物かレビューログから導出される列。ドラッグでは着地できない
      return null;
  }
}

/** 応答を待たずに見せている並べ替え。`base` のボードを表示している間だけ効く */
interface PendingMove {
  readonly base: BoardData;
  readonly id: string;
  readonly target: MoveTarget;
}

export function Board({ board, selectedId, onSelect, onChanged, onAddCard, onError }: BoardProps) {
  const [dragging, setDragging] = useState<BoardCard | null>(null);
  const [pending, setPending] = useState<PendingMove | null>(null);

  // ボードを取り直したら（SSE か応答後の再取得）、サーバの並びをそのまま信じる
  const cards =
    pending !== null && pending.base === board
      ? applyMove(board.cards, pending.id, pending.target)
      : board.cards;

  const reportError = (cause: unknown): void => {
    onError(cause instanceof Error ? cause.message : String(cause));
  };

  const handleDrop = (stage: Stage): void => {
    const card = dragging;
    setDragging(null);

    if (card === null || card.stage === stage) return;
    if (!card.droppableStages.includes(stage)) return;

    const patch = patchForStage(stage);
    if (patch === null) return;

    updateCardMeta(card.id, patch).then(onChanged).catch(reportError);
  };

  const handleReorder = (card: BoardCard, target: MoveTarget): void => {
    setDragging(null);
    setPending({ base: board, id: card.id, target });

    moveCard(card.id, target)
      .then(onChanged)
      .catch((cause: unknown) => {
        // 並びが古かった（409）ときも含め、先行表示を捨ててサーバの並びに戻す
        setPending(null);
        reportError(cause);
        onChanged();
      });
  };

  return (
    <div className="board">
      {board.stages.map((stage) => (
        <Column
          key={stage}
          stage={stage}
          cards={cards.filter((card) => card.stage === stage)}
          selectedId={selectedId}
          dragging={dragging}
          onSelect={onSelect}
          onDragStart={setDragging}
          onDragEnd={() => setDragging(null)}
          onDrop={handleDrop}
          onReorder={handleReorder}
          onAdd={stage === 'idea' ? onAddCard : undefined}
        />
      ))}
    </div>
  );
}
