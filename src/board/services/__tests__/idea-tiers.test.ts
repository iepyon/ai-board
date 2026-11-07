import { describe, it, expect } from 'vitest';
import { DIVIDER_ID } from '../../../shared/card-reorder.js';
import { ideaRows, splitIdeas } from '../idea-tiers.js';

// ============================================================
// アイデアの区切り線
// ============================================================

describe('splitIdeas', () => {
  const idea = (id: string, rank: number | null, created = '2026-09-01T00:00:00.000Z') => ({
    id,
    rank,
    created,
  });

  it('区切り線が未設定なら、すべて「次にやる」に入る', () => {
    const tiers = splitIdeas([idea('a', 1000), idea('b', null)], null);

    expect(tiers.next.map((card) => card.id)).toEqual(['a', 'b']);
    expect(tiers.later).toEqual([]);
  });

  it('rank が区切り線より小さいものが「次にやる」、大きいものが「あとで考える」', () => {
    const tiers = splitIdeas([idea('a', 1000), idea('b', 2000), idea('c', 3000)], 2500);

    expect(tiers.next.map((card) => card.id)).toEqual(['a', 'b']);
    expect(tiers.later.map((card) => card.id)).toEqual(['c']);
  });

  it('rank の無いアイデアは作成時刻で比べる', () => {
    const created = '2026-09-10T00:00:00.000Z';
    const divider = Date.parse('2026-09-05T00:00:00.000Z');

    const tiers = splitIdeas(
      [idea('old', null, '2026-09-01T00:00:00.000Z'), idea('new', null, created)],
      divider
    );

    expect(tiers.next.map((card) => card.id)).toEqual(['old']);
    expect(tiers.later.map((card) => card.id)).toEqual(['new']);
  });

  it('区切り線が先頭より前にあれば、すべて「あとで考える」に入る', () => {
    const tiers = splitIdeas([idea('a', 1000), idea('b', 2000)], 0);

    expect(tiers.next).toEqual([]);
    expect(tiers.later.map((card) => card.id)).toEqual(['a', 'b']);
  });
});

describe('ideaRows', () => {
  const idea = (id: string, rank: number) => ({ id, rank, created: '2026-09-01T00:00:00.000Z' });

  it('「次にやる」、区切り線、「あとで考える」の順に並べる', () => {
    const rows = ideaRows([idea('a', 1000), idea('b', 2000), idea('c', 3000)], 1500);

    expect(rows.map((row) => row.id)).toEqual(['a', DIVIDER_ID, 'b', 'c']);
    expect(rows[1]?.kind).toBe('divider');
  });

  it('区切り線が未設定なら末尾に置く', () => {
    const rows = ideaRows([idea('a', 1000), idea('b', 2000)], null);

    expect(rows.map((row) => row.id)).toEqual(['a', 'b', DIVIDER_ID]);
  });
});
