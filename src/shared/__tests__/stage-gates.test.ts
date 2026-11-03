import { describe, it, expect } from 'vitest';
import { GATE_OF_STAGE, withSkipGate } from '../stage-gates.js';

// ============================================================
// 飛ばす宣言の出し入れ
// ============================================================

describe('withSkipGate', () => {
  it('宣言が無いところへ入れる', () => {
    expect(withSkipGate([], 'plan', true)).toEqual(['plan']);
  });

  it('既に入っているものを入れても重ならない', () => {
    expect(withSkipGate(['plan'], 'plan', true)).toEqual(['plan']);
  });

  it('外す', () => {
    expect(withSkipGate(['plan'], 'plan', false)).toEqual([]);
  });

  it('無いものを外しても変わらない', () => {
    expect(withSkipGate([], 'plan', false)).toEqual([]);
  });
});

// ============================================================
// 列が待つゲート
// ============================================================

describe('GATE_OF_STAGE', () => {
  it('ボタンで判断を待つ列は計画レビューだけで、plan を待つ', () => {
    expect(GATE_OF_STAGE).toEqual({ 'plan-review': 'plan' });
  });
});
