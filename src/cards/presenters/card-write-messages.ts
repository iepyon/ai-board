import { describeDataStoreError } from '../../infrastructure/data-store-messages.js';
import type { CardWriteError } from '../errors/card-errors.js';

// ============================================================
// カードの書き込みの失敗を、人に読ませる 1 行にする
// ============================================================

/**
 * カードの書き込みの usecase が返したエラーを 1 行にする。
 *
 * CLI（`ai-board card`）も、戻す HTTP の入口も、これを呼んで同じ文を出す。改行と出力先は呼ぶ側が決める。
 */
export function describeCardWriteError(error: CardWriteError): string {
  switch (error.type) {
    case 'CardNotFound':
      return `カードが見つかりません: ${error.id}`;
    case 'DuplicateCardId':
      return `同じ ID のカードが既にあります: ${error.id}`;
    case 'InvalidCardId':
      return `カード ID が不正です: ${error.reason}`;
    case 'SubmitBeforeStart':
      return 'plan の提出は着手したカードにしかできません（着手は人が指示します）';
    case 'SubmitGateClosed':
      return `${error.gate} の提出は、${error.gate} が未提出か差し戻されたときにしかできません（今の ${error.gate} ゲート: ${error.state}）`;
    case 'HoldGateNotRejected':
      return `保留は ${error.gate} の最新の判断が差し戻しのときにしか書けません`;
    case 'CardWriteRefused':
      return `カードのファイルへの書き込みを拒みました（${error.reason}）`;
    case 'ReviewEntriesChanged':
      return '## レビュー のエントリが変わる差し替えはできません。提出 / 再提出は submit で追記してください';
    default:
      // 残りは DataStoreError。describeDataStoreError の switch が種別を網羅する
      return describeDataStoreError(error);
  }
}
