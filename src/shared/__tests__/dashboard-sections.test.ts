import { describe, it, expect } from 'vitest';
import { DIVIDER_ID } from '../card-reorder.js';
import {
  groupBySection,
  ideaRows,
  isStale,
  mergedAt,
  splitIdeas,
  waitingSince,
  type SectionCard,
} from '../dashboard-sections.js';

function makeCard(overrides: Partial<SectionCard> & Pick<SectionCard, 'id'>): SectionCard {
  return {
    stage: 'idea',
    aborted: false,
    startedAt: null,
    latestReview: null,
    plan: null,
    mrState: null,
    ...overrides,
  };
}

function mr(overrides: Partial<NonNullable<SectionCard['mrState']>> = {}): SectionCard['mrState'] {
  return { latestCommitAt: null, mergedAt: null, ...overrides };
}

const ids = (cards: readonly SectionCard[]): string[] => cards.map((card) => card.id);

// ============================================================
// 区画への振り分け
// ============================================================

describe('groupBySection', () => {
  it('ステージから区画を決める', () => {
    const sections = groupBySection([
      makeCard({ id: 'a', stage: 'idea' }),
      makeCard({ id: 'b', stage: 'planning' }),
      makeCard({ id: 'c', stage: 'plan-review' }),
      makeCard({ id: 'd', stage: 'impling' }),
      makeCard({ id: 'e', stage: 'pr' }),
      makeCard({ id: 'f', stage: 'merged' }),
    ]);

    expect(ids(sections.idea)).toEqual(['a']);
    expect(ids(sections.work)).toEqual(['b', 'd']);
    expect(ids(sections.inbox)).toEqual(['c', 'e']);
    expect(ids(sections.merged)).toEqual(['f']);
    expect(sections.aborted).toEqual([]);
  });

  it('中止されたカードはステージによらず中止の区画へ寄せる', () => {
    const sections = groupBySection([
      makeCard({ id: 'waiting', stage: 'plan-review', aborted: true }),
      makeCard({ id: 'idea', stage: 'idea', aborted: true }),
    ]);

    expect(ids(sections.aborted)).toEqual(['waiting', 'idea']);
    expect(sections.inbox).toEqual([]);
    expect(sections.idea).toEqual([]);
  });

  it('アイデアと AI 作業中は受け取った順（rank の順）を保つ', () => {
    const sections = groupBySection([
      makeCard({ id: 'z', stage: 'idea' }),
      makeCard({ id: 'a', stage: 'idea' }),
      makeCard({ id: 'm', stage: 'impling', plan: { updatedAt: '2026-09-01T00:00:00Z' } }),
      makeCard({ id: 'b', stage: 'impling', plan: { updatedAt: '2026-09-20T00:00:00Z' } }),
    ]);

    expect(ids(sections.idea)).toEqual(['z', 'a']);
    expect(ids(sections.work)).toEqual(['m', 'b']);
  });

  it('判断待ちは待ち始めた時刻の古い順に並べる', () => {
    const sections = groupBySection([
      makeCard({ id: 'new', stage: 'plan-review', latestReview: { at: '2026-09-25T00:00:00Z' } }),
      makeCard({ id: 'unknown', stage: 'plan-review' }),
      makeCard({ id: 'pr', stage: 'pr', mrState: mr({ latestCommitAt: '2026-09-21T00:00:00Z' }) }),
      makeCard({ id: 'old', stage: 'plan-review', latestReview: { at: '2026-09-20T00:00:00Z' } }),
    ]);

    // 時刻の取れないカードは末尾
    expect(ids(sections.inbox)).toEqual(['old', 'pr', 'new', 'unknown']);
  });

  it('マージ済みはマージの新しい順に並べる', () => {
    const sections = groupBySection([
      makeCard({ id: 'old', stage: 'merged', mrState: mr({ mergedAt: '2026-09-10T00:00:00Z' }) }),
      makeCard({ id: 'archived', stage: 'merged', plan: { updatedAt: '2026-09-15T00:00:00Z' } }),
      makeCard({ id: 'new', stage: 'merged', mrState: mr({ mergedAt: '2026-09-25T00:00:00Z' }) }),
    ]);

    expect(ids(sections.merged)).toEqual(['new', 'archived', 'old']);
  });

  it('同じ時刻なら元の順を保つ', () => {
    const at = { at: '2026-09-20T00:00:00Z' };
    const sections = groupBySection([
      makeCard({ id: 'first', stage: 'plan-review', latestReview: at }),
      makeCard({ id: 'second', stage: 'plan-review', latestReview: at }),
    ]);

    expect(ids(sections.inbox)).toEqual(['first', 'second']);
  });
});

// ============================================================
// 時刻の取り方
// ============================================================

describe('waitingSince', () => {
  it('計画レビューは提出の時刻', () => {
    const card = makeCard({
      id: 'a',
      stage: 'plan-review',
      latestReview: { at: '2026-09-20T00:00:00Z' },
      plan: { updatedAt: '2026-09-22T00:00:00Z' },
    });

    expect(waitingSince(card)).toBe('2026-09-20T00:00:00Z');
  });

  it('提出が無ければ計画ファイルの更新時刻で代える', () => {
    const card = makeCard({
      id: 'a',
      stage: 'plan-review',
      plan: { updatedAt: '2026-09-22T00:00:00Z' },
    });

    expect(waitingSince(card)).toBe('2026-09-22T00:00:00Z');
  });

  it('PR中 は最新コミットの時刻', () => {
    const card = makeCard({
      id: 'a',
      stage: 'pr',
      latestReview: { at: '2026-09-01T00:00:00Z' },
      mrState: mr({ latestCommitAt: '2026-09-21T00:00:00Z' }),
    });

    expect(waitingSince(card)).toBe('2026-09-21T00:00:00Z');
  });

  it('PR中 でコミットの時刻が無ければ計画の提出時刻', () => {
    const card = makeCard({
      id: 'a',
      stage: 'pr',
      latestReview: { at: '2026-09-01T00:00:00Z' },
      mrState: mr(),
    });

    expect(waitingSince(card)).toBe('2026-09-01T00:00:00Z');
  });
});

describe('mergedAt', () => {
  it('PR の merged_at を優先する', () => {
    const card = makeCard({
      id: 'a',
      stage: 'merged',
      plan: { updatedAt: '2026-09-22T00:00:00Z' },
      mrState: mr({ mergedAt: '2026-09-20T00:00:00Z' }),
    });

    expect(mergedAt(card)).toBe('2026-09-20T00:00:00Z');
  });

  it('PR が無ければ archive された計画の更新時刻', () => {
    const card = makeCard({
      id: 'a',
      stage: 'merged',
      plan: { updatedAt: '2026-09-22T00:00:00Z' },
    });

    expect(mergedAt(card)).toBe('2026-09-22T00:00:00Z');
  });
});

// ============================================================
// 動きなし
// ============================================================

describe('isStale', () => {
  const now = new Date('2026-09-26T00:00:00Z');

  it('計画ファイルの更新から 3 日たっていれば true', () => {
    const card = makeCard({
      id: 'a',
      stage: 'impling',
      plan: { updatedAt: '2026-09-23T00:00:00Z' },
    });

    expect(isStale(card, now)).toBe(true);
  });

  it('3 日たっていなければ false', () => {
    const card = makeCard({
      id: 'a',
      stage: 'impling',
      plan: { updatedAt: '2026-09-23T00:00:01Z' },
    });

    expect(isStale(card, now)).toBe(false);
  });

  it('計画が無ければ着手の時刻を見る', () => {
    const card = makeCard({ id: 'a', stage: 'planning', startedAt: '2026-09-20T00:00:00Z' });

    expect(isStale(card, now)).toBe(true);
  });

  it('時刻がどちらも無ければ false', () => {
    expect(isStale(makeCard({ id: 'a', stage: 'planning' }), now)).toBe(false);
  });
});

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
