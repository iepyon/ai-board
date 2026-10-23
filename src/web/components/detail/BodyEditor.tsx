import { useEffect, useState } from 'react';
import { updateCardBody } from '../../api.js';
import { BodyView } from './BodyView.js';
import type { BoardCard } from '../../types.js';

// ============================================================
// Markdown 本文の表示と編集
// ============================================================

interface BodyEditorProps {
  card: BoardCard;
  saving: boolean;
  onRun: (action: () => Promise<unknown>) => Promise<void>;
}

/** 編集中の状態。`base` は編集を始めたときの本文で、外での書き換えに気付くために持つ */
interface Editing {
  readonly draft: string;
  readonly base: string;
}

/**
 * 本文は読む場面の方が多いので、整形した表示を既定にし、「編集」で textarea に切り替える。
 *
 * 閲覧中は外での書き換え（CLI やエージェント）にそのまま追従する。
 * 編集中は書きかけを上書きせず、書き換わったことだけを知らせる。読み直すかは人が選ぶ。
 */
export function BodyEditor({ card, saving, onRun }: BodyEditorProps) {
  const [editing, setEditing] = useState<Editing | null>(null);

  // 別のカードを選び直したら閲覧に戻る
  useEffect(() => setEditing(null), [card.id]);

  const startEditing = (): void => setEditing({ draft: card.body, base: card.body });

  if (editing === null) {
    return (
      <>
        <h3>本文</h3>
        <BodyView body={card.body} />

        <div className="actions">
          <button type="button" className="btn" onClick={startEditing}>
            編集
          </button>
          <span className="status">{`.ai-board/board.db · ${card.id}`}</span>
        </div>
      </>
    );
  }

  const dirty = editing.draft !== card.body;
  const changedOutside = editing.base !== card.body;

  // 保存に成功したときだけ閲覧へ戻る。失敗したら書きかけを残す（onRun が理由を出す）
  const save = (): Promise<void> =>
    onRun(async () => {
      await updateCardBody(card.id, editing.draft);
      setEditing(null);
    });

  return (
    <>
      <h3>本文</h3>

      {changedOutside && (
        <div className="divergence">
          保存されている本文が外で書き換わりました。このまま保存すると、その変更を上書きします。
          <button type="button" className="btn ghost" onClick={startEditing}>
            書きかけを捨てて読み直す
          </button>
        </div>
      )}

      <textarea
        value={editing.draft}
        onChange={(event) => setEditing({ ...editing, draft: event.target.value })}
        spellCheck={false}
        placeholder="## アイデア"
      />

      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={saving || !dirty}
          onClick={() => void save()}
        >
          本文を保存
        </button>

        <button type="button" className="btn ghost" onClick={() => setEditing(null)}>
          {dirty ? '取り消す' : '閉じる'}
        </button>

        <span className="status">{`.ai-board/board.db · ${card.id}`}</span>
      </div>
    </>
  );
}
