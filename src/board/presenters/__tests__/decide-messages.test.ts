import { describe, it, expect } from 'vitest';
import { createCardId } from '../../../shared/schemas/common.js';
import { describeDataStoreError } from '../../../infrastructure/data-store-messages.js';
import type { DecideError } from '../../errors/board-errors.js';
import { describeDecided, describeDecideError } from '../decide-messages.js';

const id = createCardId('a1');

describe('describeDecided', () => {
  it('列が変わったら、前と後の列を矢印で並べる', () => {
    expect(describeDecided({ id, what: '着手', from: 'idea', to: 'planning' })).toBe(
      'a1: 着手 を書きました（アイデア → 計画提案中）'
    );
  });

  it('列が変わらなければ、今の列だけを出す', () => {
    expect(
      describeDecided({ id, what: 'plan を飛ばす宣言を入れる', from: 'idea', to: 'idea' })
    ).toBe('a1: plan を飛ばす宣言を入れる を書きました（アイデア）');
  });

  it('書いた後の列を読めなければ、そう書く', () => {
    expect(describeDecided({ id, what: 'plan 中止', from: 'idea', to: null })).toBe(
      'a1: plan 中止 を書きました（書いた後の列は読めませんでした）'
    );
  });
});

describe('describeDecideError', () => {
  it.each<[string, DecideError, string]>([
    [
      'GitHub に繋がらない（判断）',
      {
        type: 'ForgeUnavailable',
        action: 'review',
        forge: { status: 'error', kind: 'github', message: '失敗' },
      },
      'GitHub に繋がらないので、承認 / 差し戻し / 中止は書けません（GitHub: エラー（失敗））',
    ],
    [
      'GitHub に繋がらない（着手）',
      {
        type: 'ForgeUnavailable',
        action: 'startedAt',
        forge: { status: 'error', kind: 'github', message: '失敗' },
      },
      'GitHub に繋がらないので、着手 / 着手を戻すは書けません（GitHub: エラー（失敗））',
    ],
    ['カードが無い', { type: 'CardNotFound', id }, 'カードが見つかりません: a1'],
    [
      '理由が要る',
      { type: 'ReasonRequired', kind: '差し戻し' },
      '差し戻しには --reason で理由を書いてください',
    ],
    [
      '中止済みのカード',
      { type: 'CardAborted', id },
      'a1 は中止されているので、飛ばす宣言を変えられません',
    ],
    [
      'アイデアの表に無い',
      { type: 'NotInIdeaTable', ref: 'a1' },
      'アイデアの表に無いカードです: a1',
    ],
    [
      'ボードが読めない',
      { type: 'BoardUnreadable', reason: '壊れている' },
      'ボードを読めませんでした: 壊れている',
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
  ])('%s', (_name, error, expected) => {
    expect(describeDecideError(error)).toBe(expected);
  });

  it('データ用ブランチの失敗は describeDataStoreError と同じ文にする', () => {
    const error = { type: 'DataStoreLockTimeout', lockPath: '/repo/.ai-board/data.lock' } as const;

    expect(describeDecideError(error)).toBe(describeDataStoreError(error));
  });
});
