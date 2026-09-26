import { describe, it, expect } from 'vitest';
import { applyMove, moveTargetFor } from '../card-reorder.js';

// ============================================================
// ドロップ位置 → 隣のカード
// ============================================================

describe('moveTargetFor', () => {
  const ids = ['a', 'b', 'c', 'd'];

  it('先頭へ落とす', () => {
    expect(moveTargetFor(ids, 'c', 0)).toEqual({ after: null, before: 'a' });
  });

  it('末尾へ落とす', () => {
    expect(moveTargetFor(ids, 'a', 4)).toEqual({ after: 'd', before: null });
  });

  it('上から下へ動かす', () => {
    expect(moveTargetFor(ids, 'a', 3)).toEqual({ after: 'c', before: 'd' });
  });

  it('下から上へ動かす', () => {
    expect(moveTargetFor(ids, 'd', 1)).toEqual({ after: 'a', before: 'b' });
  });

  it('元の位置の前後へ落としても何もしない', () => {
    expect(moveTargetFor(ids, 'b', 1)).toBeNull();
    expect(moveTargetFor(ids, 'b', 2)).toBeNull();
  });

  it('列にいないカードは扱わない', () => {
    expect(moveTargetFor(ids, 'x', 0)).toBeNull();
  });
});

// ============================================================
// 表示の先行並べ替え
// ============================================================

describe('applyMove', () => {
  const items = ['a', 'b', 'c', 'd'].map((id) => ({ id }));
  const order = (list: { id: string }[]): string[] => list.map((item) => item.id);

  it('after の直後へ入れる', () => {
    expect(order(applyMove(items, 'd', { after: 'a', before: 'b' }))).toEqual(['a', 'd', 'b', 'c']);
  });

  it('after が無ければ before の直前へ入れる', () => {
    expect(order(applyMove(items, 'c', { after: null, before: 'a' }))).toEqual([
      'c',
      'a',
      'b',
      'd',
    ]);
  });

  it('列の隣が全体では離れていても after の直後に入れる', () => {
    // a と d が同じ列、b と c は別の列
    expect(order(applyMove(items, 'a', { after: 'd', before: null }))).toEqual([
      'b',
      'c',
      'd',
      'a',
    ]);
  });

  it('隣が見つからなければ並びを変えない', () => {
    expect(order(applyMove(items, 'a', { after: 'x', before: null }))).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });
});
