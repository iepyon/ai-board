import type { BoardCard } from '../../types.js';

// ============================================================
// 計画の表示
// ============================================================

/**
 * 計画の PR へのリンクを出す。人が承認 / 否決を判断する材料になるので、
 * レビューボタンより手前に置く。
 *
 * 計画の本文はボードに持たない。AI は計画をコミットした時点で Draft の PR を出し、
 * 人はその PR で計画を読む。計画ファイルはブランチにあり、ボードを動かす
 * チェックアウトからは見えないことが多い。
 */
export function PlanSection({ card }: { card: BoardCard }) {
  const mr = card.mrState;
  const tasks = card.plan?.tasks;

  return (
    <>
      <h3>計画</h3>

      {tasks !== undefined && tasks.total > 0 && (
        <p className="movable">
          タスク {tasks.completed}/{tasks.total}
          {card.plan?.archived === true && '（archive 済み）'}
        </p>
      )}

      {mr === null ? (
        <p className="movable">まだ計画の PR がありません。</p>
      ) : (
        <p className="mr-link">
          <a href={mr.webUrl} target="_blank" rel="noreferrer">
            計画の PR #{mr.iid} を開く ↗
          </a>
          {mr.draft && '（Draft）'}
        </p>
      )}
    </>
  );
}
