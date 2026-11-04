import { useEffect } from 'react';
import { StageSection } from './detail/StageSection.js';
import { PlanSection } from './detail/PlanSection.js';
import { ReviewActions } from './detail/ReviewActions.js';
import { LinkFields } from './detail/LinkFields.js';
import { SkipGateField } from './detail/SkipGateField.js';
import { BodyEditor } from './detail/BodyEditor.js';
import { ReviewLog } from './detail/ReviewLog.js';
import { SummaryLine } from './detail/SummaryLine.js';
import { HoldNote } from './detail/HoldNote.js';
import { LoopSteps } from './detail/LoopSteps.js';
import { updateCardMeta, type CardMetaPatch } from '../api.js';
import { useAction } from '../hooks/useAction.js';
import { awaitsDecision } from '../../shared/dashboard-sections.js';
import type { BoardCard } from '../types.js';

// ============================================================
// カード詳細パネル
// ============================================================

interface CardDetailProps {
  card: BoardCard;
  onClose: () => void;
  onChanged: () => void;
}

export function CardDetail({ card, onClose, onChanged }: CardDetailProps) {
  const { saving, error, run, clearError } = useAction(onChanged);

  // 別のカードを選び直したらエラー表示を消す
  useEffect(clearError, [card.id, clearError]);

  const patch = (values: CardMetaPatch): Promise<void> =>
    run(() => updateCardMeta(card.id, values));

  return (
    <aside className="detail" aria-label={`${card.title} の詳細`}>
      <div className="detail-head">
        <div className="detail-title">
          <h2>{card.title}</h2>
          <SummaryLine card={card} />
        </div>
        <button type="button" className="btn ghost" onClick={onClose}>
          閉じる
        </button>
      </div>

      <div className="detail-body">
        {error !== null && <div className="divergence">{error}</div>}

        {/* 判断を待つカード（計画レビューと、止まっているカード）だけ、本文を読んですぐ押せるよう判断のボタンを先頭に置く */}
        <HoldNote card={card} />
        {awaitsDecision(card) && <ReviewActions card={card} saving={saving} onRun={run} />}
        <BodyEditor card={card} saving={saving} onRun={run} />
        <ReviewLog reviews={card.reviews} />
        <StageSection card={card} />
        <PlanSection card={card} />
        <LoopSteps steps={card.loopSteps} />
        <SkipGateField card={card} saving={saving} onPatch={patch} />
        <LinkFields card={card} saving={saving} onPatch={patch} />
      </div>
    </aside>
  );
}
