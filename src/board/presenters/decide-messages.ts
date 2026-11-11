import type { Stage } from '../../shared/schemas/common.js';
import { STAGE_LABELS } from '../../shared/stage-labels.js';
import { describeDataStoreError } from '../../infrastructure/data-store-messages.js';
import { decisionsFor } from '../services/decision-options.js';
import type { BoardCard } from '../models/board-card.js';
import type { DecideError, DecideRefusal } from '../errors/board-errors.js';
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
 * 判断を書けない理由の 1 行。
 *
 * GitHub に繋がらない（設定があって使えない・エラー）ときは、PR の状態が引けないと計画レビューのカードが手前の列に落ちて見え、
 * 出せる判断や戻せる列を取り違えるので拒む（`status` が `next` を `null` にするのと同じ理由）。
 * 未設定のボードは拒まない（`forgeTrusted`）。
 */
export function describeRefusal(refusal: DecideRefusal): string {
  switch (refusal.type) {
    case 'ForgeUnavailable': {
      const what = refusal.action === 'review' ? '承認 / 差し戻し / 中止' : '着手 / 着手を戻す';
      return `GitHub に繋がらないので、${what}は書けません（GitHub: ${describeForge(refusal.forge)}）`;
    }
    case 'CardNotFound':
      return `カードが見つかりません: ${refusal.id}`;
    case 'DecisionUnavailable':
      return `${refusal.id} に ${refusal.kind} は書けません（${describeChoices(refusal.card)}）`;
    case 'ReasonRequired':
      return `${refusal.kind}には --reason で理由を書いてください`;
    case 'StageMismatch':
      return (
        `${refusal.id} は${startedAtLabel(refusal.from)}できません（今の列: ${STAGE_LABELS[refusal.card.stage]}。` +
        `${STAGE_LABELS[refusal.from]}にあり、${STAGE_LABELS[refusal.to]}へ入れられるカードだけ）` +
        forgeHoldNote(refusal.card)
      );
    case 'CardAborted':
      return `${refusal.id} は中止されているので、飛ばす宣言を変えられません`;
    case 'NotInIdeaTable':
      return `アイデアの表に無いカードです: ${refusal.ref}`;
  }
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

export function describeDecideError(error: DecideError): string {
  switch (error.type) {
    case 'BoardUnreadable':
      return `ボードを読めませんでした: ${error.reason}`;
    case 'CardNotFound':
      return `カードが見つかりません: ${error.id}`;
    case 'StaleOrder':
      return `--after（${error.after}）と --before（${error.before}）の並びが今の表と逆です。status で並びを読み直してください`;
    case 'CardWriteRefused':
      return `カードのファイルへの書き込みを拒みました（${error.reason}）`;
    case 'ForgeUnavailable':
    case 'DecisionUnavailable':
    case 'ReasonRequired':
    case 'StageMismatch':
    case 'CardAborted':
    case 'NotInIdeaTable':
      return describeRefusal(error);
    default:
      // 残りは DataStoreError。describeDataStoreError の switch が種別を網羅する
      return describeDataStoreError(error);
  }
}
