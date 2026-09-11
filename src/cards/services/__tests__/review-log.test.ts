import { describe, it, expect } from 'vitest';
import { appendReviewEntry, gateState, isAborted, parseReviewLog } from '../review-log.js';
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

  it('skipGates に含まれていればエントリを見ずに approved', () => {
    expect(gateState(entries.slice(0, 2), 'plan', ['plan'])).toBe('approved');
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

  it('中止は承認済みのゲートを巻き戻さない', () => {
    const aborted: ReviewEntry[] = [
      { at: '2026-09-11T04:00:00.000Z', gate: 'plan', kind: '承認', reason: '' },
      { at: '2026-09-11T05:00:00.000Z', gate: 'plan', kind: '中止', reason: 'やめる' },
    ];

    expect(gateState(aborted, 'plan', [])).toBe('approved');
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
