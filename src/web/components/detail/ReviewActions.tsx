import { useEffect, useState } from 'react';
import { appendReview } from '../../api.js';
import { GATE_OF_STAGE, STAGE_LABELS, type BoardCard } from '../../types.js';

// ============================================================
// 承認 / 否決 / 中止
// ============================================================

interface ReviewActionsProps {
  card: BoardCard;
  saving: boolean;
  onRun: (action: () => Promise<unknown>) => Promise<void>;
}

/**
 * 人の判断をカード本文の `## レビュー` へ追記する。
 *
 * ステージは書かない。追記されたログをサーバが読み直し、
 * 次のボード取得で列が変わる。
 */
export function ReviewActions({ card, saving, onRun }: ReviewActionsProps) {
  const [reason, setReason] = useState('');

  // 別のカードを選び直したら書きかけの理由を捨てる
  useEffect(() => setReason(''), [card.id]);

  const gate = GATE_OF_STAGE[card.stage];

  if (gate === undefined) {
    return (
      <>
        <h3>レビュー</h3>
        <p className="movable">{STAGE_LABELS[card.stage]} は判断を待つ列ではありません。</p>
      </>
    );
  }

  const submit = (kind: '承認' | '否決' | '中止'): void => {
    void onRun(async () => {
      await appendReview(card.id, { gate, kind, reason });
      setReason('');
    });
  };

  const noReason = reason.trim() === '';

  return (
    <>
      <h3>レビュー</h3>

      <textarea
        className="reason-input"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        spellCheck={false}
        placeholder="否決の理由（AI が次の周回で読みます）"
      />

      <div className="actions">
        <button type="button" className="btn" disabled={saving} onClick={() => submit('承認')}>
          承認
        </button>

        <button
          type="button"
          className="btn ghost"
          disabled={saving || noReason}
          title={noReason ? '否決には理由が必要です' : undefined}
          onClick={() => submit('否決')}
        >
          否決して差し戻す
        </button>

        <button
          type="button"
          className="btn ghost"
          disabled={saving}
          onClick={() => submit('中止')}
        >
          中止する
        </button>
      </div>
    </>
  );
}
