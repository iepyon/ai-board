import { withSkipGate } from '../../../shared/stage-gates.js';
import type { CardMetaPatch } from '../../api.js';
import type { BoardCard } from '../../types.js';

// ============================================================
// ゲートを飛ばす宣言
// ============================================================

interface SkipGateFieldProps {
  card: BoardCard;
  saving: boolean;
  onPatch: (patch: CardMetaPatch) => void;
}

/**
 * `skipGates` の `plan` を出し入れする。宣言されたゲートでは、AI の 提出 / 再提出 が
 * 人の承認と同じに読まれる。plan を飛ばすカードも着手するまではアイデアに留まり、
 * AI が計画を提出した時点で計画レビューを通らずに実装中へ進む。
 * 否決 / 保留 / 承認 はふつうに効く。
 *
 * 書くのは飛ばす宣言という実フラグであり、ステージではない。1 つのゲートを出し入れしても、
 * 他のゲートの宣言は保つ。宣言を書く入口は人が使うここだけで、AI も使う CLI には足さない。
 */
export function SkipGateField({ card, saving, onPatch }: SkipGateFieldProps) {
  const skipPlan = card.skipGates.includes('plan');

  return (
    <>
      <h3>ゲート</h3>

      <label className="check-field">
        <input
          type="checkbox"
          checked={skipPlan}
          disabled={saving}
          onChange={(event) =>
            onPatch({ skipGates: withSkipGate(card.skipGates, 'plan', event.target.checked) })
          }
        />
        計画レビューを飛ばす
      </label>
      <p className="movable">
        印を入れると、AI
        が計画を提出した時点で計画レビューを通ったものとみなします。提出済みのカードはすぐに実装中へ進みます。
      </p>
    </>
  );
}
