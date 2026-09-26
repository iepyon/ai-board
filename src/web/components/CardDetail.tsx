import { useEffect } from 'react';
import { StageSection } from './detail/StageSection.js';
import { PlanSection } from './detail/PlanSection.js';
import { ReviewActions } from './detail/ReviewActions.js';
import { LinkFields } from './detail/LinkFields.js';
import { BodyEditor } from './detail/BodyEditor.js';
import { updateCardMeta, type CardMetaPatch } from '../api.js';
import { useAction } from '../hooks/useAction.js';
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
        <h2>{card.title}</h2>
        <button type="button" className="btn ghost" onClick={onClose}>
          閉じる
        </button>
      </div>

      <div className="detail-body">
        {error !== null && <div className="divergence">{error}</div>}

        <StageSection card={card} />
        <PlanSection card={card} />
        <ReviewActions card={card} saving={saving} onRun={run} />
        <LinkFields card={card} saving={saving} onPatch={patch} />
        <BodyEditor card={card} saving={saving} onRun={run} />
      </div>
    </aside>
  );
}
