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
  // 別のカードを選び直したときは、App が CardDetail を key で作り直すので、編集の状態も消える
  const [editing, setEditing] = useState<Editing | null>(null);

  // 保存した直後、ボードを取り直すまでのあいだ出す本文。取り直して card.body が変わったら外す
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => setSaved(null), [card.body]);

  // 保存した直後は、取り直す前の古い card.body ではなく保存した本文から書き始める
  const startEditing = (): void => {
    const body = saved ?? card.body;
    setEditing({ draft: body, base: body });
  };

  if (editing === null) {
    return (
      <>
        <h3>本文</h3>
        <BodyView body={saved ?? card.body} />

        <div className="actions">
          <button type="button" className="btn" onClick={startEditing}>
            編集
          </button>
          <span className="status">{`.ai-board/board.db · ${card.id}`}</span>
        </div>
      </>
    );
  }

  // 書きかけは編集を始めたときの本文と比べる。外での書き換えだけで保存できるようにはしない
  // （何も書いていないのに保存すると、外の変更を古い本文で戻してしまう）
  const dirty = editing.draft !== editing.base;
  const changedOutside = editing.base !== card.body;

  // 保存に成功したときだけ閲覧へ戻る。失敗したら書きかけを残す（onRun が理由を出す）
  const save = (): Promise<void> =>
    onRun(async () => {
      const updated = await updateCardBody(card.id, editing.draft);
      setSaved(updated.body);
      setEditing(null);
    });

  return (
    <>
      <h3>本文</h3>

      {changedOutside && (
        <div className="divergence">
          保存されている本文が外で書き換わりました。このまま保存すると、その変更を上書きします。
          <div className="actions">
            <button type="button" className="btn ghost" onClick={startEditing}>
              書きかけを捨てて読み直す
            </button>
          </div>
        </div>
      )}

      <textarea
        value={editing.draft}
        onChange={(event) => setEditing({ ...editing, draft: event.target.value })}
        spellCheck={false}
        placeholder="## アイデア"
        readOnly={saving}
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
          {dirty ? '取り消す' : '編集をやめる'}
        </button>

        <span className="status">{`.ai-board/board.db · ${card.id}`}</span>
      </div>
    </>
  );
}
