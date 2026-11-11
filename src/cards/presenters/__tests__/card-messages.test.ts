import { describe, it, expect } from 'vitest';
import { createCardId } from '../../../shared/schemas/common.js';
import { describeDataStoreError } from '../../../infrastructure/data-store-messages.js';
import type { CardUsecaseError } from '../../errors/card-errors.js';
import { describeCardError } from '../card-messages.js';

const id = createCardId('a1');

describe('describeCardError', () => {
  it.each<[string, CardUsecaseError, string]>([
    ['カードが無い', { type: 'CardNotFound', id }, 'カードが見つかりません: a1'],
    ['ID が重なる', { type: 'DuplicateCardId', id }, '同じ ID のカードが既にあります: a1'],
    [
      'ID が不正',
      { type: 'InvalidCardId', reason: 'kebab-case ではない' },
      'カード ID が不正です: kebab-case ではない',
    ],
    [
      '着手前の提出',
      { type: 'SubmitBeforeStart', id },
      'plan の提出は着手したカードにしかできません（着手は人が指示します）',
    ],
    [
      '提出できないゲート',
      { type: 'SubmitGateClosed', id, gate: 'plan', state: 'submitted' },
      'plan の提出は、plan が未提出か差し戻されたときにしかできません（今の plan ゲート: submitted）',
    ],
    [
      '差し戻しでないときの保留',
      { type: 'HoldGateNotRejected', id, gate: 'plan', state: 'submitted' },
      '保留は plan の最新の判断が差し戻しのときにしか書けません',
    ],
    [
      '並びが古い',
      { type: 'StaleOrder', after: 'a1', before: 'a2' },
      '--after（a1）と --before（a2）の並びが今の表と逆です。status で並びを読み直してください',
    ],
    [
      'ファイルへの書き込みの拒否',
      { type: 'CardWriteRefused', reason: '判断が増える' },
      'カードのファイルへの書き込みを拒みました（判断が増える）',
    ],
    [
      '## レビュー が変わる差し替え',
      { type: 'ReviewEntriesChanged', id },
      '## レビュー のエントリが変わる差し替えはできません。提出 / 再提出は submit で追記してください',
    ],
  ])('%s', (_name, error, expected) => {
    expect(describeCardError(error)).toBe(expected);
  });

  it('データ用ブランチの失敗は describeDataStoreError と同じ文にする', () => {
    const error = { type: 'DataStoreLockTimeout', lockPath: '/repo/.ai-board/data.lock' } as const;

    expect(describeCardError(error)).toBe(describeDataStoreError(error));
  });
});
