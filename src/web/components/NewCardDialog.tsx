import { useState, type FormEvent } from 'react';
import { createCard } from '../api.js';

// ============================================================
// 新規アイデアカードの作成
// ============================================================

interface NewCardDialogProps {
  onClose: () => void;
  onCreated: () => void;
}

export function NewCardDialog({ onClose, onCreated }: NewCardDialogProps) {
  const [title, setTitle] = useState('');
  const [id, setId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError(null);

    try {
      await createCard({ title: title.trim(), ...(id.trim() === '' ? {} : { id: id.trim() }) });
      onCreated();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form className="dialog" onSubmit={(event) => void submit(event)}>
        <h2>アイデアを追加</h2>

        <div className="field">
          <label htmlFor="new-title">タイトル</label>
          <input
            id="new-title"
            value={title}
            autoFocus
            required
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="new-id">ID（任意）</label>
          <input
            id="new-id"
            value={id}
            placeholder="refresh-token"
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            onChange={(event) => setId(event.target.value)}
          />
        </div>
        <p className="hint">
          省略するとタイトルから生成します。日本語だけのタイトルでは生成できないため、その場合は ID
          を入力してください。
        </p>

        {error !== null && <div className="divergence">{error}</div>}

        <div className="actions">
          <button type="submit" className="btn" disabled={saving || title.trim() === ''}>
            作成
          </button>
          <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>
            キャンセル
          </button>
        </div>
      </form>
    </div>
  );
}
