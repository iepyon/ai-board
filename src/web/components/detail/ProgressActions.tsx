import type { BoardCard } from '../../types.js';
import type { CardMetaPatch } from '../../api.js';

// ============================================================
// explored / impling の明示マーカー操作
// ============================================================

interface ProgressActionsProps {
  card: BoardCard;
  saving: boolean;
  onPatch: (patch: CardMetaPatch) => void;
}

/**
 * explored と impling はファイルからは観測できないため、
 * ここで打刻する以外に立てる手段がない。
 */
export function ProgressActions({ card, saving, onPatch }: ProgressActionsProps) {
  return (
    <>
      <h3>進行</h3>

      <div className="actions">
        <button
          type="button"
          className="btn ghost"
          disabled={saving}
          onClick={() => onPatch({ explored: !card.explored })}
        >
          {card.explored ? '探索済みを取り消す' : '探索済みにする'}
        </button>

        <button
          type="button"
          className="btn ghost"
          disabled={saving}
          onClick={() =>
            onPatch({
              implStartedAt: card.implStartedAt === null ? new Date().toISOString() : null,
            })
          }
        >
          {card.implStartedAt === null ? '実装開始' : '実装開始を取り消す'}
        </button>
      </div>
    </>
  );
}
