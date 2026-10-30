import { withSkipGate } from '../../../shared/stage-gates.js';
import type { CardMetaPatch } from '../../api.js';
import type { BoardCard } from '../../types.js';

// ============================================================
// 動作確認を飛ばす宣言
// ============================================================

interface SkipGateFieldProps {
  card: BoardCard;
  saving: boolean;
  onPatch: (patch: CardMetaPatch) => void;
}

/**
 * `skipGates` の `verify` を出し入れする。宣言されたゲートは承認済みと同じに扱われ、
 * 動作確認の列を通らずに PR中 へ進む。
 *
 * 書くのは飛ばす宣言という実フラグであり、ステージではない。他のゲートの宣言は保つ。
 * 宣言を書く入口は人が使うここだけで、AI も使う CLI には足さない。
 */
export function SkipGateField({ card, saving, onPatch }: SkipGateFieldProps) {
  const skipped = card.skipGates.includes('verify');

  return (
    <>
      <h3>ゲート</h3>

      <label className="check-field">
        <input
          type="checkbox"
          checked={skipped}
          disabled={saving}
          onChange={(event) =>
            onPatch({ skipGates: withSkipGate(card.skipGates, 'verify', event.target.checked) })
          }
        />
        動作確認を飛ばす
      </label>
      <p className="movable">
        印を入れると、AI は実装を終えたら動作確認を頼まずに PR を Ready にします。
      </p>
    </>
  );
}
