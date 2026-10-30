import { describe, it, expect } from 'vitest';
import { withSkipGate } from '../stage-gates.js';

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
});
