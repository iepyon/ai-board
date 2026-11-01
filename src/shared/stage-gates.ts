import { stageRank, type Stage } from './schemas/common.js';

/**
 * その列が人の判断を待っているゲート。待ちの列でなければ undefined。
 *
 * 値は `ReviewGate`（`src/cards/models/review.ts`）と同じ。`src/shared/` は web からも読むので、
 * コンテキストの型を引かずにリテラルで書く。画面のレビューボタンと、
 * ボードの `latestReview` がどのゲートのエントリを選ぶかの両方に使う。
 */
export const GATE_OF_STAGE: Partial<Record<Stage, 'plan' | 'verify'>> = {
  'plan-review': 'plan',
  verifying: 'verify',
};

/**
 * 飛ばす宣言（`skipGates`）に `gate` を入れる / 外した後の値。他のゲートの宣言はそのまま保つ。
 *
 * 宣言を書くのは人だけ（詳細パネルのチェックボックス）。CLI に入口は無い。
 * 既に入っているものを入れても、無いものを外しても値は変わらない。
 */
export function withSkipGate<G extends 'plan' | 'verify'>(
  skipGates: readonly G[],
  gate: G,
  skip: boolean
): G[] {
  const others = skipGates.filter((each) => each !== gate);

  return skip ? [...others, gate] : others;
}

/**
 * 詳細パネルに「動作確認を飛ばす」のチェックボックスを出すか。
 *
 * 動作確認の列をまだ通っていない（進行度が `verifying` 以下の）、中止でないカードだけ真を返す。
 * PR中・マージ済みのカードはもう動作確認の列を通らず、中止のカードは作業も判断も待っていないので、
 * 宣言を入れても何も変わらない。効かない操作を画面に出さないために使う。
 *
 * ステージを列挙せず進行度で比べるので、列が増えても `verifying` より前か後かで決まる。
 * `src/shared/` は web からも読むので、サーバの `BoardCard` の型は引かず、使う形だけを受け取る。
 */
export function offersSkipVerify(card: { stage: Stage; aborted: boolean }): boolean {
  return !card.aborted && stageRank(card.stage) <= stageRank('verifying');
}
