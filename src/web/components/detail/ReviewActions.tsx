import { useEffect, useState } from 'react';
import { appendReview } from '../../api.js';
import { decisionsFor, type Decision } from '../../../shared/dashboard-sections.js';
import type { BoardCard } from '../../types.js';

// ============================================================
// 承認 / 否決 / 中止
// ============================================================

/**
 * 理由の欄に出す書き方の手がかり。AI は差し戻された先でこの理由を読む。
 *
 * 否決はどれも plan のゲートに書き、AI は計画を直す（実装中のカードなら計画から立て直す）。
 */
function reasonPlaceholder(decisions: readonly Decision[]): string {
  const rejects = decisions.filter((decision) => decision.kind === '否決');

  if (rejects.length === 0) return '中止の理由（任意）';

  return '否決の理由（AI が次の周回で読み、計画を直します）';
}

interface ReviewActionsProps {
  card: BoardCard;
  saving: boolean;
  onRun: (action: () => Promise<unknown>) => Promise<void>;
}

/**
 * 人の判断をカード本文の `## レビュー` へ追記する。
 *
 * どのボタンを出すかは `decisionsFor` が決める。ステージは書かない。
 * 追記されたログをサーバが読み直し、次のボード取得で列が変わる。
 */
export function ReviewActions({ card, saving, onRun }: ReviewActionsProps) {
  const [reason, setReason] = useState('');

  // 別のカードを選び直したら書きかけの理由を捨てる
  useEffect(() => setReason(''), [card.id]);

  const decisions = decisionsFor(card);

  // 判断を待っていなければ何も出さない（呼び出し側は `awaitsDecision` のカードにだけ使う）
  if (decisions.length === 0) return null;

  const submit = (decision: Decision): void => {
    void onRun(async () => {
      await appendReview(card.id, { gate: decision.gate, kind: decision.kind, reason });
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
        placeholder={reasonPlaceholder(decisions)}
      />

      <div className="actions">
        {decisions.map((decision) => {
          const blocked = decision.reasonRequired && noReason;

          return (
            <button
              key={`${decision.gate}-${decision.kind}-${decision.label}`}
              type="button"
              className={decision.kind === '承認' ? 'btn' : 'btn ghost'}
              disabled={saving || blocked}
              title={blocked ? `「${decision.label}」には理由が必要です` : undefined}
              onClick={() => submit(decision)}
            >
              {decision.label}
            </button>
          );
        })}
      </div>
    </>
  );
}
