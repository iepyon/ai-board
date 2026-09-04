import { useEffect, useState } from 'react';
import { updateCardBody } from '../../api.js';
import type { BoardCard } from '../../types.js';

// ============================================================
// Markdown 本文の編集
// ============================================================

interface BodyEditorProps {
  card: BoardCard;
  saving: boolean;
  onRun: (action: () => Promise<unknown>) => Promise<void>;
}

export function BodyEditor({ card, saving, onRun }: BodyEditorProps) {
  const [body, setBody] = useState(card.body);

  // 別のカードを選び直したとき、および外部で書き換えられたときに追従する
  useEffect(() => setBody(card.body), [card.id, card.body]);

  const dirty = body !== card.body;

  return (
    <>
      <h3>本文</h3>

      <textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        spellCheck={false}
        placeholder="## アイデア&#10;&#10;## 探索メモ"
      />

      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={saving || !dirty}
          onClick={() => void onRun(() => updateCardBody(card.id, body))}
        >
          本文を保存
        </button>

        {dirty && (
          <button type="button" className="btn ghost" onClick={() => setBody(card.body)}>
            取り消す
          </button>
        )}

        <span className="status">{`.ai-board/cards/${card.id}.md`}</span>
      </div>
    </>
  );
}
