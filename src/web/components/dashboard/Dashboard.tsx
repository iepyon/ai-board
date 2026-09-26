import { useMemo, useState } from 'react';
import { InboxSection } from './InboxSection.js';
import { WorkSection } from './WorkSection.js';
import { IdeaTable } from './IdeaTable.js';
import { AbortedTable, MergedTable } from './FoldedTables.js';
import { moveCard, updateCardMeta, type CardMetaPatch } from '../../api.js';
import { applyMove, type MoveTarget } from '../../../shared/card-reorder.js';
import { groupBySection } from '../../../shared/dashboard-sections.js';
import type { Board as BoardData, BoardCard } from '../../types.js';

// ============================================================
// 縦に積んだダッシュボード
// ============================================================

interface DashboardProps {
  board: BoardData;
  onSelect: (card: BoardCard) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}

/** 応答を待たずに見せている並べ替え。`base` のボードを表示している間だけ効く */
interface PendingMove {
  readonly base: BoardData;
  readonly id: string;
  readonly target: MoveTarget;
}

/**
 * 区画への振り分けは見せ方だけで、ステージはサーバの導出をそのまま使う。
 *
 * 人が動かせるのは `アイデア ⇄ 計画提案中` の 1 遷移だけで、それを「着手」「着手を戻す」の
 * ボタンで行う。書くのはその列を成立させる実フラグ（`startedAt`）であり、ステージではない。
 * 承認 / 否決 / 中止 は判断待ちの区画のレビュー欄から本文へ追記する。
 */
export function Dashboard({ board, onSelect, onChanged, onError }: DashboardProps) {
  const [pending, setPending] = useState<PendingMove | null>(null);

  // ボードを取り直したら（SSE か応答後の再取得）、サーバの並びをそのまま信じる
  const cards =
    pending !== null && pending.base === board
      ? applyMove(board.cards, pending.id, pending.target)
      : board.cards;

  const sections = useMemo(() => groupBySection(cards), [cards]);

  const reportError = (cause: unknown): void => {
    onError(cause instanceof Error ? cause.message : String(cause));
  };

  const patch = (card: BoardCard, values: CardMetaPatch): void => {
    updateCardMeta(card.id, values).then(onChanged).catch(reportError);
  };

  const handleReorder = (card: BoardCard, target: MoveTarget): void => {
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
    <>
      <InboxSection cards={sections.inbox} onSelect={onSelect} onChanged={onChanged} />
      <WorkSection
        cards={sections.work}
        onSelect={onSelect}
        onUnstart={(card) => patch(card, { startedAt: null })}
      />
      <IdeaTable
        cards={sections.idea}
        onSelect={onSelect}
        onStart={(card) => patch(card, { startedAt: new Date().toISOString() })}
        onReorder={handleReorder}
      />
      <MergedTable cards={sections.merged} onSelect={onSelect} />
      <AbortedTable cards={sections.aborted} onSelect={onSelect} />
    </>
  );
}
