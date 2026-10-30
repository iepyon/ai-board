import type { BoardCard } from '../../types.js';

// ============================================================
// 止まっているカードの、人がすること
// ============================================================

/**
 * AI の列で止まっているカードの、人が何をすればよいか（`hold.reason`）。
 * 作業者が書いた止まった理由は、続く `SubmissionNote` に保留のエントリとして出る。
 */
export function HoldNote({ card }: { card: BoardCard }) {
  if (card.hold === null) return null;

  return (
    <div className="why">
      <span className="why-kind">止まっている</span>
      {card.hold.reason}
    </div>
  );
}
