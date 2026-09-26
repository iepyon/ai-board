import { describe, it, expect } from 'vitest';
import { RANK_STEP, compareCards, effectiveRank, rankBetween, rebalance } from '../card-order.js';
import type { CardId } from '../../../shared/schemas/common.js';

function rankable(id: string, created: string, rank: number | null = null) {
  return { id: id as CardId, created, rank };
}

// ============================================================
// 実効値と比較
// ============================================================

describe('effectiveRank', () => {
  it('rank があればそれを使う', () => {
    expect(effectiveRank({ rank: 5, created: '2026-09-01T00:00:00.000Z' })).toBe(5);
  });

  it('rank が無ければ created のエポックミリ秒で補う', () => {
    expect(effectiveRank({ rank: null, created: '2026-09-01T00:00:00.000Z' })).toBe(
      Date.parse('2026-09-01T00:00:00.000Z')
    );
  });
});

describe('compareCards', () => {
  it('rank の無いカードどうしは作成順に並ぶ', () => {
    const cards = [
      rankable('b', '2026-09-02T00:00:00.000Z'),
      rankable('a', '2026-09-01T00:00:00.000Z'),
    ];

    expect(cards.sort(compareCards).map((card) => card.id)).toEqual(['a', 'b']);
  });

  it('新しく作られたカードは並べ替え済みのカードより後ろに付く', () => {
    const moved = rankable(
      'moved',
      '2026-09-01T00:00:00.000Z',
      Date.parse('2026-09-03T00:00:00.000Z')
    );
    const fresh = rankable('fresh', '2026-09-10T00:00:00.000Z');

    expect([fresh, moved].sort(compareCards).map((card) => card.id)).toEqual(['moved', 'fresh']);
  });

  it('振り直した後に作られたカードも末尾に付く', () => {
    const rebalanced = rankable('old', '2026-09-01T00:00:00.000Z', 3 * RANK_STEP);
    const fresh = rankable('fresh', '2026-09-10T00:00:00.000Z');

    expect([fresh, rebalanced].sort(compareCards).map((card) => card.id)).toEqual(['old', 'fresh']);
  });

  it('実効値が同じなら id の辞書順で決まる', () => {
    const cards = [
      rankable('b', '2026-09-01T00:00:00.000Z', 10),
      rankable('a', '2026-09-01T00:00:00.000Z', 10),
    ];

    expect(cards.sort(compareCards).map((card) => card.id)).toEqual(['a', 'b']);
  });
});

// ============================================================
// 間の値
// ============================================================

describe('rankBetween', () => {
  it('両隣の中点を返す', () => {
    expect(rankBetween(10, 20)).toBe(15);
  });

  it('先頭へは直後の値からずらす', () => {
    expect(rankBetween(null, 5000)).toBe(5000 - RANK_STEP);
  });

  it('末尾へは直前の値からずらす', () => {
    expect(rankBetween(5000, null)).toBe(5000 + RANK_STEP);
  });

  it('両隣が同じ値なら隙間が無い', () => {
    expect(rankBetween(10, 10)).toBeNull();
  });

  it('中点が表せないほど詰まったら隙間が無い', () => {
    const prev = Date.parse('2026-09-01T00:00:00.000Z');
    let next = prev + 1;
    let rank = rankBetween(prev, next);

    while (rank !== null) {
      next = rank;
      rank = rankBetween(prev, next);
    }

    expect(rank).toBeNull();
    expect(next).toBeGreaterThan(prev);
  });
});

describe('rebalance', () => {
  it('現在の順序を保ったまま刻み幅で振り直す', () => {
    const ranks = rebalance([
      rankable('c', '2026-09-03T00:00:00.000Z'),
      rankable('a', '2026-09-01T00:00:00.000Z', 7),
      rankable('b', '2026-09-01T00:00:00.000Z', 7),
    ]);

    expect([...ranks.entries()]).toEqual([
      ['a', RANK_STEP],
      ['b', 2 * RANK_STEP],
      ['c', 3 * RANK_STEP],
    ]);
  });
});
