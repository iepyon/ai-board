import { describe, it, expect } from 'vitest';
import { offersSkipVerify, withSkipGate } from '../stage-gates.js';

// ============================================================
// 飛ばす宣言の出し入れ
// ============================================================

describe('withSkipGate', () => {
  it('宣言が無いところへ入れる', () => {
    expect(withSkipGate([], 'verify', true)).toEqual(['verify']);
  });

  it('入れても他のゲートの宣言を保つ', () => {
    expect(withSkipGate(['plan'], 'verify', true)).toEqual(['plan', 'verify']);
  });

  it('既に入っているものを入れても重ならない', () => {
    expect(withSkipGate(['verify'], 'verify', true)).toEqual(['verify']);
  });

  it('外しても他のゲートの宣言を保つ', () => {
    expect(withSkipGate(['plan', 'verify'], 'verify', false)).toEqual(['plan']);
  });

  it('無いものを外しても変わらない', () => {
    expect(withSkipGate(['plan'], 'verify', false)).toEqual(['plan']);
  });

  it('plan を入れても verify の宣言を保つ', () => {
    expect(withSkipGate(['verify'], 'plan', true)).toEqual(['verify', 'plan']);
  });

  it('plan を外しても verify の宣言を保つ', () => {
    expect(withSkipGate(['plan', 'verify'], 'plan', false)).toEqual(['verify']);
  });
});

// ============================================================
// 動作確認を飛ばすチェックボックスの出し分け
// ============================================================

describe('offersSkipVerify', () => {
  it.each(['idea', 'planning', 'plan-review', 'impling', 'verifying'] as const)(
    '動作確認の列をまだ通っていない %s のカードには出す',
    (stage) => {
      expect(offersSkipVerify({ stage, aborted: false })).toBe(true);
    }
  );

  it.each(['pr', 'merged'] as const)('動作確認の後にいる %s のカードには出さない', (stage) => {
    expect(offersSkipVerify({ stage, aborted: false })).toBe(false);
  });

  it('実装中でも中止のカードには出さない', () => {
    expect(offersSkipVerify({ stage: 'impling', aborted: true })).toBe(false);
  });
});
