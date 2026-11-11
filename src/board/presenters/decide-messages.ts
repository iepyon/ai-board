import type { Stage } from '../../shared/schemas/common.js';
import { STAGE_LABELS } from '../../shared/stage-labels.js';
import { describeCardError } from '../../cards/presenters/card-messages.js';
import { decisionsFor } from '../services/decision-options.js';
import type { BoardCard } from '../models/board-card.js';
import type { DecideError } from '../errors/board-errors.js';
import type { Decided } from '../usecases/commands/decide.command.js';
import { describeForge } from './status-describe.js';

// ============================================================
// 人の判断を書いた結果と、書けなかった理由を、人に読ませる 1 行にする
// ============================================================

/**
 * 書いた後の列の移りの 1 行（例: `a1: 着手 を書きました（アイデア → 計画提案中）`）。
 * 列は usecase が書いた後のボードで読んだもの。CLI（`ai-board decide`）はこの行を出し、`board-decide` はそれを人に伝える
 */
export function describeDecided({ id, what, from, to }: Decided): string {
  const transition =
    to === null
      ? '書いた後の列は読めませんでした'
      : to === from
        ? STAGE_LABELS[to]
        : `${STAGE_LABELS[from]} → ${STAGE_LABELS[to]}`;

  return `${id}: ${what} を書きました（${transition}）`;
}

/**
 * 列を確かめて拒んだ操作の名前。`StageMismatch` を返すのは着手（アイデアから）と着手を戻す（計画提案中から）だけ
 */
function startedAtLabel(from: Stage): string {
  return from === 'idea' ? '着手' : '着手を戻す';
}

/**
 * PR の状態を引けない止まりなら、その理由を添える。
 * そのカードは出せる判断も入れられる列も無い（`decisionsFor` / `droppableStages`）ので、拒んだ理由がそれだと分かるようにする
 */
function forgeHoldNote(card: BoardCard): string {
  return card.hold?.kind === 'forge' ? `。${card.hold.reason}` : '';
}

function describeChoices(card: BoardCard): string {
  const stage = `今の列: ${STAGE_LABELS[card.stage]}${card.aborted ? '（中止済み）' : ''}`;
  const decisions = decisionsFor(card);
  if (decisions.length === 0) return `${stage}。出せる判断はありません${forgeHoldNote(card)}`;
  return `${stage}。出せる判断: ${decisions.map((d) => `${d.gate} ${d.kind}`).join(' / ')}`;
}

/**
 * 判断を書けなかった理由の 1 行。
 *
 * ボードに固有の理由（検査の拒否と、ボードが読めない）だけをここで書き、
 * 残り（カードの usecase のエラーとデータ用ブランチの失敗）は `describeCardError` に回す。
 *
 * GitHub に繋がらない（設定があって使えない・エラー）ときは、PR の状態が引けないと計画レビューのカードが手前の列に落ちて見え、
 * 出せる判断や戻せる列を取り違えるので拒む（`status` が `next` を `null` にするのと同じ理由）。
 * 未設定のボードは拒まない（`forgeTrusted`）。
 */
export function describeDecideError(error: DecideError): string {
  switch (error.type) {
    case 'ForgeUnavailable': {
      const what = error.action === 'review' ? '承認 / 差し戻し / 中止' : '着手 / 着手を戻す';
      return `GitHub に繋がらないので、${what}は書けません（GitHub: ${describeForge(error.forge)}）`;
    }
    case 'DecisionUnavailable':
      return `${error.id} に ${error.kind} は書けません（${describeChoices(error.card)}）`;
    case 'ReasonRequired':
      return `${error.kind}には --reason で理由を書いてください`;
    case 'StageMismatch':
      return (
        `${error.id} は${startedAtLabel(error.from)}できません（今の列: ${STAGE_LABELS[error.card.stage]}。` +
        `${STAGE_LABELS[error.from]}にあり、${STAGE_LABELS[error.to]}へ入れられるカードだけ）` +
        forgeHoldNote(error.card)
      );
    case 'CardAborted':
      return `${error.id} は中止されているので、飛ばす宣言を変えられません`;
    case 'NotInIdeaTable':
      return `アイデアの表に無いカードです: ${error.ref}`;
    case 'BoardUnreadable':
      return `ボードを読めませんでした: ${error.reason}`;
    default:
      // 残りはカードの usecase のエラー（CardNotFound・StaleOrder・CardWriteRefused）と DataStoreError
      return describeCardError(error);
  }
}
