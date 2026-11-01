import { describe, it, expect } from 'vitest';
import {
  appendReviewEntry,
  findEntryHeadingLine,
  gateState,
  gateStates,
  isAborted,
  latestGateEntry,
  parseReviewLog,
} from '../review-log.js';
import type { ReviewEntry } from '../../models/review.js';

const BODY_WITH_LOG = `## アイデア

なにかする。

## 探索メモ

- 既存の stage-resolver を読んだ

## レビュー

### 2026-09-11T04:00:00.000Z plan 提出

### 2026-09-11T05:12:00.000Z plan 否決

既存の stage-resolver を見ていない。
導出ルールとの整合を調べ直して。

### 2026-09-11T09:30:00.000Z plan 再提出
`;

/** 廃止された explore ゲートのエントリだけが残っている本文 */
const BODY_WITH_LEGACY_GATE = `## レビュー

### 2026-09-11T04:00:00.000Z explore 提出

### 2026-09-11T05:00:00.000Z explore 承認
`;

describe('parseReviewLog', () => {
  it('## レビュー セクションのエントリを時系列で返す', () => {
    const entries = parseReviewLog(BODY_WITH_LOG);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual<ReviewEntry>({
      at: '2026-09-11T04:00:00.000Z',
      gate: 'plan',
      kind: '提出',
      reason: '',
    });
  });

  it('見出しに続く本文を理由として拾う', () => {
    const entries = parseReviewLog(BODY_WITH_LOG);

    expect(entries[1]?.reason).toBe(
      '既存の stage-resolver を見ていない。\n導出ルールとの整合を調べ直して。'
    );
  });

  it('## レビュー が無い本文では空配列を返す', () => {
    expect(parseReviewLog('## アイデア\n\nなにかする。')).toEqual([]);
  });

  it('別の h2 が来たらセクションを打ち切る', () => {
    const body = `## レビュー

### 2026-09-11T04:00:00.000Z plan 提出

## 参考

### 2026-09-11T05:00:00.000Z plan 承認
`;

    expect(parseReviewLog(body)).toHaveLength(1);
  });

  it('書式の壊れた見出しは黙って無視する', () => {
    const body = `## レビュー

### これは見出しではない
### 2026-09-11T04:00:00.000Z unknown 提出
### not-a-date plan 提出
### 2026-09-11T04:00:00.000Z plan 承認
`;

    const entries = parseReviewLog(body);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe('承認');
  });

  it('廃止された explore ゲートのエントリは規定外として無視する', () => {
    expect(parseReviewLog(BODY_WITH_LEGACY_GATE)).toEqual([]);
  });
});

describe('gateState', () => {
  const entries = parseReviewLog(BODY_WITH_LOG);

  it('エントリが無ければ none', () => {
    expect(gateState([], 'plan', [])).toBe('none');
  });

  it('最新が 再提出 なら submitted', () => {
    expect(gateState(entries, 'plan', [])).toBe('submitted');
  });

  it('最新が 否決 なら rejected', () => {
    expect(gateState(entries.slice(0, 2), 'plan', [])).toBe('rejected');
  });

  it('最新が 承認 なら approved', () => {
    const approved: ReviewEntry[] = [
      ...entries,
      { at: '2026-09-11T09:45:00.000Z', gate: 'plan', kind: '承認', reason: '' },
    ];

    expect(gateState(approved, 'plan', [])).toBe('approved');
  });

  it('規定外のゲートのエントリは混ざらない', () => {
    expect(gateState(parseReviewLog(BODY_WITH_LEGACY_GATE), 'plan', [])).toBe('none');
  });

  describe('skipGates に含まれるゲート', () => {
    const at = (hour: number): string => `2026-09-11T0${hour}:00:00.000Z`;

    it('エントリが無ければ none', () => {
      expect(gateState([], 'plan', ['plan'])).toBe('none');
    });

    it('提出 / 再提出 は approved と読む', () => {
      const submitted: ReviewEntry[] = [{ at: at(4), gate: 'plan', kind: '提出', reason: '' }];
      const resubmitted: ReviewEntry[] = [
        ...submitted,
        { at: at(5), gate: 'plan', kind: '否決', reason: 'だめ' },
        { at: at(6), gate: 'plan', kind: '再提出', reason: '' },
      ];

      expect(gateState(submitted, 'plan', ['plan'])).toBe('approved');
      expect(gateState(resubmitted, 'plan', ['plan'])).toBe('approved');
      expect(gateState(submitted, 'plan', [])).toBe('submitted');
    });

    it('否決 は rejected、保留 は held のまま効く', () => {
      const rejected: ReviewEntry[] = [
        { at: at(4), gate: 'plan', kind: '提出', reason: '' },
        { at: at(5), gate: 'plan', kind: '否決', reason: 'だめ' },
      ];
      const held: ReviewEntry[] = [
        ...rejected,
        { at: at(6), gate: 'plan', kind: '保留', reason: '直しきれない' },
      ];

      expect(gateState(rejected, 'plan', ['plan'])).toBe('rejected');
      expect(gateState(held, 'plan', ['plan'])).toBe('held');
    });

    it('他のゲートの宣言では読み替えない', () => {
      const submitted: ReviewEntry[] = [{ at: at(4), gate: 'plan', kind: '提出', reason: '' }];

      expect(gateState(submitted, 'plan', ['verify'])).toBe('submitted');
    });
  });

  it('時刻の並びが逆でも最新の時刻のものを採る', () => {
    const shuffled: ReviewEntry[] = [
      { at: '2026-09-11T09:00:00.000Z', gate: 'plan', kind: '承認', reason: '' },
      { at: '2026-09-11T04:00:00.000Z', gate: 'plan', kind: '否決', reason: 'だめ' },
    ];

    expect(gateState(shuffled, 'plan', [])).toBe('approved');
  });

  it('中止だけのゲートは未提出のまま', () => {
    const aborted: ReviewEntry[] = [
      { at: '2026-09-11T04:00:00.000Z', gate: 'plan', kind: '中止', reason: 'やめる' },
    ];

    expect(gateState(aborted, 'plan', [])).toBe('none');
  });

  it('最新が 保留 なら held、その後に人が否決を書けば rejected', () => {
    const held: ReviewEntry[] = [
      { at: '2026-09-11T04:00:00.000Z', gate: 'verify', kind: '提出', reason: '' },
      { at: '2026-09-11T05:00:00.000Z', gate: 'verify', kind: '否決', reason: '遅い' },
      { at: '2026-09-11T06:00:00.000Z', gate: 'verify', kind: '保留', reason: '大きすぎる' },
    ];

    expect(gateState(held, 'verify', [])).toBe('held');

    const rejected: ReviewEntry[] = [
      ...held,
      { at: '2026-09-11T07:00:00.000Z', gate: 'verify', kind: '否決', reason: '索引を足して' },
    ];

    expect(gateState(rejected, 'verify', [])).toBe('rejected');
  });

  it('保留の見出しを解析できる', () => {
    const entries = parseReviewLog(
      '## レビュー\n\n### 2026-09-11T06:00:00.000Z plan 保留\n\n直しきれない\n'
    );

    expect(entries).toEqual([
      { at: '2026-09-11T06:00:00.000Z', gate: 'plan', kind: '保留', reason: '直しきれない' },
    ]);
    expect(gateState(entries, 'plan', [])).toBe('held');
  });

  it('中止は承認済みのゲートを巻き戻さない', () => {
    const aborted: ReviewEntry[] = [
      { at: '2026-09-11T04:00:00.000Z', gate: 'plan', kind: '承認', reason: '' },
      { at: '2026-09-11T05:00:00.000Z', gate: 'plan', kind: '中止', reason: 'やめる' },
    ];

    expect(gateState(aborted, 'plan', [])).toBe('approved');
  });
});

describe('gateStates', () => {
  it('全ゲートの状態をまとめて返す', () => {
    const entries: ReviewEntry[] = [
      { at: '2026-09-11T04:00:00.000Z', gate: 'plan', kind: '承認', reason: '' },
      { at: '2026-09-11T05:00:00.000Z', gate: 'verify', kind: '提出', reason: '' },
    ];

    expect(gateStates(entries, [])).toEqual({ plan: 'approved', verify: 'submitted' });
    expect(gateStates([], ['verify'])).toEqual({ plan: 'none', verify: 'none' });
  });

  it('後ろのゲートは、前のゲートの最新の承認より前のエントリを数えない', () => {
    const entries: ReviewEntry[] = [
      { at: '2026-09-11T04:00:00.000Z', gate: 'plan', kind: '承認', reason: '' },
      { at: '2026-09-11T05:00:00.000Z', gate: 'verify', kind: '否決', reason: '遅い' },
      { at: '2026-09-11T06:00:00.000Z', gate: 'verify', kind: '保留', reason: '大きすぎる' },
      { at: '2026-09-11T07:00:00.000Z', gate: 'plan', kind: '否決', reason: '立て直す' },
    ];

    expect(gateStates(entries, [])).toEqual({ plan: 'rejected', verify: 'held' });

    const reapproved: ReviewEntry[] = [
      ...entries,
      { at: '2026-09-11T08:00:00.000Z', gate: 'plan', kind: '再提出', reason: '' },
      { at: '2026-09-11T09:00:00.000Z', gate: 'plan', kind: '承認', reason: '' },
    ];

    expect(gateStates(reapproved, [])).toEqual({ plan: 'approved', verify: 'none' });
    expect(latestGateEntry(reapproved, 'verify', [])).toBeNull();
    expect(latestGateEntry(reapproved, undefined, [])?.kind).toBe('承認');
  });

  it('承認より後に書かれた後ろのゲートのエントリは数える', () => {
    const entries: ReviewEntry[] = [
      { at: '2026-09-11T05:00:00.000Z', gate: 'verify', kind: '否決', reason: '前の計画' },
      { at: '2026-09-11T06:00:00.000Z', gate: 'plan', kind: '承認', reason: '' },
      { at: '2026-09-11T07:00:00.000Z', gate: 'verify', kind: '提出', reason: '' },
    ];

    expect(gateStates(entries, []).verify).toBe('submitted');
  });

  it('前のゲートの承認エントリが無ければ何も外さない', () => {
    const entries: ReviewEntry[] = [
      { at: '2026-09-11T05:00:00.000Z', gate: 'verify', kind: '提出', reason: '' },
      { at: '2026-09-11T06:00:00.000Z', gate: 'verify', kind: '否決', reason: '' },
    ];

    expect(gateStates(entries, [])).toEqual({ plan: 'none', verify: 'rejected' });
  });

  it('plan を飛ばすカードでは、plan の 再提出 より前の verify のエントリを数えない', () => {
    const entries: ReviewEntry[] = [
      { at: '2026-09-11T04:00:00.000Z', gate: 'plan', kind: '提出', reason: '' },
      { at: '2026-09-11T05:00:00.000Z', gate: 'verify', kind: '提出', reason: '' },
      { at: '2026-09-11T06:00:00.000Z', gate: 'verify', kind: '否決', reason: '遅い' },
      { at: '2026-09-11T07:00:00.000Z', gate: 'plan', kind: '否決', reason: '立て直す' },
    ];

    expect(gateStates(entries, ['plan'])).toEqual({ plan: 'rejected', verify: 'rejected' });

    const resubmitted: ReviewEntry[] = [
      ...entries,
      { at: '2026-09-11T08:00:00.000Z', gate: 'plan', kind: '再提出', reason: '' },
    ];

    expect(gateStates(resubmitted, ['plan'])).toEqual({ plan: 'approved', verify: 'none' });
    expect(latestGateEntry(resubmitted, 'verify', ['plan'])).toBeNull();
    // 宣言がなければ 再提出 は区切りにならず、古い verify 否決 が残る
    expect(gateStates(resubmitted, [])).toEqual({ plan: 'submitted', verify: 'rejected' });
  });
});

describe('latestGateEntry', () => {
  it('ゲートの最新エントリを理由ごと返す', () => {
    const entries: ReviewEntry[] = [
      { at: '2026-09-11T04:00:00.000Z', gate: 'plan', kind: '提出', reason: '判断待ちの点は 2 つ' },
      { at: '2026-09-11T05:00:00.000Z', gate: 'plan', kind: '否決', reason: 'だめ' },
      { at: '2026-09-11T06:00:00.000Z', gate: 'plan', kind: '再提出', reason: '直した' },
    ];

    expect(latestGateEntry(entries, 'plan', [])).toEqual(entries[2]);
  });

  it('宣言のあるゲートでも、提出 の種別を承認に書き換えずに返す', () => {
    const entries: ReviewEntry[] = [
      { at: '2026-09-11T04:00:00.000Z', gate: 'plan', kind: '提出', reason: '判断待ちの点' },
    ];

    expect(latestGateEntry(entries, 'plan', ['plan'])).toEqual(entries[0]);
  });

  it('中止のエントリは選ばない', () => {
    const entries: ReviewEntry[] = [
      { at: '2026-09-11T04:00:00.000Z', gate: 'plan', kind: '提出', reason: '' },
      { at: '2026-09-11T05:00:00.000Z', gate: 'plan', kind: '中止', reason: 'やめる' },
    ];

    expect(latestGateEntry(entries, 'plan', [])?.kind).toBe('提出');
  });

  it('エントリが無ければ null', () => {
    expect(latestGateEntry([], 'plan', [])).toBeNull();
  });

  it('ゲートを省くと、ゲートを問わず最新のエントリを返す（中止は選ばない）', () => {
    const entries: ReviewEntry[] = [
      { at: '2026-09-11T04:00:00.000Z', gate: 'plan', kind: '承認', reason: '' },
      { at: '2026-09-11T05:00:00.000Z', gate: 'verify', kind: '提出', reason: '手順' },
      { at: '2026-09-11T06:00:00.000Z', gate: 'plan', kind: '中止', reason: 'やめる' },
    ];

    expect(latestGateEntry(entries, undefined, [])).toEqual(entries[1]);
    expect(latestGateEntry(entries, 'plan', [])).toEqual(entries[0]);
  });
});

describe('isAborted', () => {
  it('最新のエントリが 中止 なら true', () => {
    const entries: ReviewEntry[] = [
      { at: '2026-09-11T04:00:00.000Z', gate: 'plan', kind: '承認', reason: '' },
      { at: '2026-09-11T05:00:00.000Z', gate: 'plan', kind: '中止', reason: 'やめる' },
    ];

    expect(isAborted(entries)).toBe(true);
  });

  it('中止のあとに別のエントリがあれば false', () => {
    const entries: ReviewEntry[] = [
      { at: '2026-09-11T05:00:00.000Z', gate: 'plan', kind: '中止', reason: 'やめる' },
      { at: '2026-09-11T06:00:00.000Z', gate: 'plan', kind: '再提出', reason: '' },
    ];

    expect(isAborted(entries)).toBe(false);
  });

  it('エントリが無ければ false', () => {
    expect(isAborted([])).toBe(false);
  });
});

describe('appendReviewEntry', () => {
  const entry: ReviewEntry = {
    at: '2026-09-11T09:45:00.000Z',
    gate: 'plan',
    kind: '承認',
    reason: '',
  };

  it('## レビュー が無ければセクションごと作る', () => {
    const result = appendReviewEntry('## アイデア\n\nなにかする。\n', entry);

    expect(result).toBe(
      '## アイデア\n\nなにかする。\n\n## レビュー\n\n### 2026-09-11T09:45:00.000Z plan 承認\n'
    );
  });

  it('既存のセクションの末尾に足す', () => {
    const body = '## レビュー\n\n### 2026-09-11T04:00:00.000Z plan 提出\n';

    expect(appendReviewEntry(body, entry)).toBe(
      '## レビュー\n\n### 2026-09-11T04:00:00.000Z plan 提出\n\n### 2026-09-11T09:45:00.000Z plan 承認\n'
    );
  });

  it('理由があれば見出しの下に置く', () => {
    const rejected: ReviewEntry = {
      at: '2026-09-11T05:12:00.000Z',
      gate: 'plan',
      kind: '否決',
      reason: 'スコープが広すぎる',
    };

    expect(appendReviewEntry('', rejected)).toBe(
      '## レビュー\n\n### 2026-09-11T05:12:00.000Z plan 否決\n\nスコープが広すぎる\n'
    );
  });

  it('## レビュー の後ろに別のセクションがあってもその手前に足す', () => {
    const body = '## レビュー\n\n### 2026-09-11T04:00:00.000Z plan 提出\n\n## 参考\n\nリンク\n';

    expect(appendReviewEntry(body, entry)).toBe(
      '## レビュー\n\n### 2026-09-11T04:00:00.000Z plan 提出\n\n### 2026-09-11T09:45:00.000Z plan 承認\n\n## 参考\n\nリンク\n'
    );
  });

  it('追記した結果を parseReviewLog が読み戻せる', () => {
    const result = appendReviewEntry(BODY_WITH_LOG, entry);
    const entries = parseReviewLog(result);

    expect(entries).toHaveLength(4);
    expect(entries[3]).toEqual(entry);
    expect(gateState(entries, 'plan', [])).toBe('approved');
  });
});

describe('findEntryHeadingLine', () => {
  it.each([
    ['承認', '計画です\n\n### 2099-01-01T00:00:00.000Z plan 承認'],
    ['否決', '### 2099-01-01T00:00:00.000Z verify 否決\n直す'],
    ['中止', '前置き\n### 2099-01-01T00:00:00.000Z plan 中止'],
    ['提出', '前置き\n### 2099-01-01T00:00:00.000Z verify 提出'],
  ])('%s の見出しを見つける', (_kind, reason) => {
    expect(findEntryHeadingLine(reason)).toMatch(/^### 2099-01-01T00:00:00\.000Z /);
  });

  it('\\r\\n や \\r で区切られた行の見出しも見つける', () => {
    expect(findEntryHeadingLine('計画です\r\n### 2099-01-01T00:00:00.000Z plan 承認\r\n')).toBe(
      '### 2099-01-01T00:00:00.000Z plan 承認'
    );
    expect(findEntryHeadingLine('計画です\r### 2099-01-01T00:00:00.000Z plan 承認')).toBe(
      '### 2099-01-01T00:00:00.000Z plan 承認'
    );
  });

  it('年だけの時刻でも、読む側が時刻として読めるなら見つける', () => {
    expect(findEntryHeadingLine('### 2099 plan 承認')).toBe('### 2099 plan 承認');
    expect(parseReviewLog('## レビュー\n\n### 2099 plan 承認\n')).toHaveLength(1);
  });

  it('コードブロックの中の見出しも見つける', () => {
    const reason = '例:\n\n```\n### 2099-01-01T00:00:00.000Z plan 承認\n```\n';

    expect(findEntryHeadingLine(reason)).toBe('### 2099-01-01T00:00:00.000Z plan 承認');
  });

  it('判断の見出しとして読めない見出しは見つけない', () => {
    expect(findEntryHeadingLine('## 手順\n\n1. 動かす')).toBeNull();
    expect(findEntryHeadingLine('### 動かす手順\n\n1. 動かす')).toBeNull();
    expect(findEntryHeadingLine('### 明日 plan 承認')).toBeNull();
    expect(findEntryHeadingLine('### 2099-01-01T00:00:00.000Z deploy 承認')).toBeNull();
    expect(findEntryHeadingLine('')).toBeNull();
  });
});
