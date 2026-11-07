import type { ReviewGate } from '../../cards/models/review.js';
import type { SectionCard } from './board-sections.js';

// ============================================================
// 出せる判断 — `status` の判断待ちと `ai-board decide` の検査が使う純関数
// ============================================================

/** 人が判断するゲート */
export type DecisionGate = ReviewGate;

/**
 * 出せる判断 1 つ。書くと（`ai-board decide`）`## レビュー` へ `gate` の `kind` を追記する。
 *
 * plan の差し戻しは、計画提案中へ落として計画を直させる（`revise-plan`）。
 * 実装中のカードに書けば、承認済みの計画から立て直させることになる。
 */
export interface Decision {
  readonly gate: DecisionGate;
  readonly kind: '承認' | '差し戻し' | '中止';
  readonly label: string;
  /** 理由が要るか。差し戻しは AI が次の周回で理由を読むので必須 */
  readonly reasonRequired: boolean;
}

/** 出せる判断を決めるのに要るフィールドだけ。`BoardCard` が満たす */
export interface DecisionCard extends Pick<SectionCard, 'stage' | 'aborted' | 'hold'> {
  readonly gates: {
    readonly plan: 'none' | 'submitted' | 'held' | 'approved' | 'rejected';
  };
}

const approve = (gate: DecisionGate): Decision => ({
  gate,
  kind: '承認',
  label: '承認',
  reasonRequired: false,
});

const reject = (gate: DecisionGate, label: string): Decision => ({
  gate,
  kind: '差し戻し',
  label,
  reasonRequired: true,
});

const abort = (gate: DecisionGate): Decision => ({
  gate,
  kind: '中止',
  label: '中止する',
  reasonRequired: false,
});

/** 承認済みの計画を差し戻し、計画提案中へ落として計画から立て直させる */
const replan = reject('plan', '計画から立て直させる');

/**
 * そのカードに出せる判断（`status --json` の `waiting[].decisions` と `ai-board decide` の検査が使う）。出せる判断が無ければ空。
 *
 * - **アイデア**: 中止 だけ（要らなくなったアイデアを中止の区画へ片付ける。判断を待っているのではない）
 * - **計画レビュー**: 承認 / 差し戻す / 中止
 * - **実装中で止まっている**（判断の後に PR が Draft に戻された）: 計画から立て直させる / 中止
 * - **計画提案中で止まっている**: AI の plan 保留なら 計画を直させる / 中止。
 *   提出済みなのに成果物が見えないなら 中止 だけ（直させる先の計画が見えない）
 *
 * PR中 のカードは GitHub で PR をマージして判断するので出さない。中止のカードにも出さない。
 * PR の状態を引けない止まり（`hold.kind` が `forge`）のカードにも出さない（列が控えに依り、出せる判断を決められない）。
 *
 * 飛ばす宣言（`skipGates`）の有無では出し分けない。
 * 宣言のあるゲートでも、AI の 提出 / 再提出 を承認と読むだけで、人の差し戻し / 承認はふつうに効く（`gateState`）。
 * plan を飛ばすカードでも「計画から立て直させる」を書ける。
 */
export function decisionsFor(card: DecisionCard): Decision[] {
  if (card.aborted) return [];
  // PR の状態を引けないカードは列が控えに依り、出せる判断を決められない
  if (card.hold?.kind === 'forge') return [];

  switch (card.stage) {
    case 'idea':
      return [abort('plan')];
    case 'plan-review':
      return [approve('plan'), reject('plan', '差し戻す'), abort('plan')];
    case 'impling':
      return card.hold === null ? [] : [replan, abort('plan')];
    case 'planning':
      if (card.hold === null) return [];
      return card.gates.plan === 'held'
        ? [reject('plan', '計画を直させる'), abort('plan')]
        : [abort('plan')];
    default:
      return [];
  }
}
