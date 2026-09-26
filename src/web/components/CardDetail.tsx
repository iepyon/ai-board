import { useEffect, useState } from 'react';
import { StageSection } from './detail/StageSection.js';
import { PlanSection } from './detail/PlanSection.js';
import { ReviewActions } from './detail/ReviewActions.js';
import { LinkFields } from './detail/LinkFields.js';
import { BodyEditor } from './detail/BodyEditor.js';
import { updateCardMeta, type CardMetaPatch } from '../api.js';
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 別のカードを選び直したらエラー表示を消す
  useEffect(() => setError(null), [card.id]);

  /** 保存処理を包む。成功したらボードを取り直す */
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

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
