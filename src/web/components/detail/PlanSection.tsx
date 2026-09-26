import { useEffect, useState } from 'react';
import { fetchPlan } from '../../api.js';
import type { BoardCard, PlanDocument } from '../../types.js';

// ============================================================
// 計画の表示
// ============================================================

/**
 * 計画ファイルの本文を出す。人が承認 / 否決を判断する材料になるので、
 * レビューボタンより手前に置く。
 *
 * 本文はボードのレスポンスに載せていない（計画はカード本文より桁違いに
 * 大きく、ファイル変更のたびに引き直されるため）。ここで個別に取りに行く。
 *
 * Markdown は整形せず等幅のまま出す。見出しとチェックボックスは素のままでも
 * 読めるので、レンダラを 1 つ増やすほどの利得が無い。
 */
export function PlanSection({ card }: { card: BoardCard }) {
  const [plan, setPlan] = useState<PlanDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (card.plan === null) {
      setPlan(null);
      setError(null);
      return;
    }

    let current = true;

    fetchPlan(card.id)
      .then((next) => {
        if (current) {
          setPlan(next);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (current) {
          setPlan(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });

    return () => {
      current = false;
    };
  }, [card.id, card.plan]);

  if (card.plan === null) {
    return (
      <>
        <h3>計画</h3>
        <p className="movable">まだ計画がありません（.ai-board/plans/{card.id}.md）。</p>
      </>
    );
  }

  return (
    <>
      <h3>計画</h3>

      {card.plan.tasks.total > 0 && (
        <p className="movable">
          タスク {card.plan.tasks.completed}/{card.plan.tasks.total}
          {card.plan.archived && '（archive 済み）'}
        </p>
      )}

      {error !== null && <div className="divergence">{error}</div>}
      {error === null && plan === null && <p className="movable">読み込み中…</p>}
      {plan !== null && <pre className="plan-body">{plan.body}</pre>}
    </>
  );
}
