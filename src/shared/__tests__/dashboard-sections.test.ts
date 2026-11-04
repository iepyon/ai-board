import { describe, it, expect } from 'vitest';
import { DIVIDER_ID } from '../card-reorder.js';
import {
  awaitsDecision,
  decisionsFor,
  groupBySection,
  ideaRows,
  isStale,
  mergedAt,
  splitIdeas,
  waitingSince,
  type DecisionCard,
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
    hold: null,
    ...overrides,
  };
}

function mr(overrides: Partial<NonNullable<SectionCard['mrState']>> = {}): SectionCard['mrState'] {
  return { latestCommitAt: null, mergedAt: null, awaitingFix: false, ...overrides };
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

  it('PR中 で人の指摘に AI が応える番のカードは、AI が進めている区画の先頭に入れる', () => {
    const sections = groupBySection([
      makeCard({ id: 'planning', stage: 'planning' }),
      makeCard({ id: 'impling', stage: 'impling' }),
      makeCard({ id: 'fix-a', stage: 'pr', mrState: mr({ awaitingFix: true }) }),
      makeCard({ id: 'waiting-pr', stage: 'pr', mrState: mr({ awaitingFix: false }) }),
      makeCard({ id: 'fix-b', stage: 'pr', mrState: mr({ awaitingFix: true }) }),
    ]);

    // 指摘に応えるカードどうしと、残りのカードは受け取った並び（rank の順）を保つ
    expect(ids(sections.work)).toEqual(['fix-a', 'fix-b', 'planning', 'impling']);
    expect(ids(sections.inbox)).toEqual(['waiting-pr']);
  });

  it('中止された PR中 のカードは、指摘があっても中止の区画へ寄せる', () => {
    const sections = groupBySection([
      makeCard({ id: 'x', stage: 'pr', aborted: true, mrState: mr({ awaitingFix: true }) }),
    ]);

    expect(ids(sections.aborted)).toEqual(['x']);
    expect(sections.work).toEqual([]);
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

  it('止まっているカードは AI の列にいても判断待ちへ出し、AI 作業中に含めない', () => {
    const hold = { reason: '止まっている', since: '2026-09-20T00:00:00Z' };
    const sections = groupBySection([
      makeCard({ id: 'held-impl', stage: 'impling', hold }),
      makeCard({ id: 'held-plan', stage: 'planning', hold }),
      makeCard({ id: 'working', stage: 'impling' }),
    ]);

    expect(ids(sections.inbox)).toEqual(['held-impl', 'held-plan']);
    expect(ids(sections.work)).toEqual(['working']);
  });

  it('中止は止まりより強い', () => {
    const sections = groupBySection([
      makeCard({
        id: 'aborted',
        stage: 'impling',
        aborted: true,
        hold: { reason: '止まっている', since: '2026-09-20T00:00:00Z' },
      }),
    ]);

    expect(ids(sections.aborted)).toEqual(['aborted']);
    expect(sections.inbox).toEqual([]);
  });

  it('止まっているカードも判断待ちの中で待ち始めた時刻の順に並ぶ', () => {
    const sections = groupBySection([
      makeCard({
        id: 'review',
        stage: 'plan-review',
        latestReview: { at: '2026-09-22T00:00:00Z' },
      }),
      makeCard({
        id: 'held',
        stage: 'impling',
        latestReview: { at: '2026-09-25T00:00:00Z' },
        hold: { reason: '止まっている', since: '2026-09-21T00:00:00Z' },
      }),
    ]);

    expect(ids(sections.inbox)).toEqual(['held', 'review']);
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
      makeCard({ id: 'mid', stage: 'plan-review', latestReview: { at: '2026-09-23T00:00:00Z' } }),
      makeCard({ id: 'old', stage: 'plan-review', latestReview: { at: '2026-09-20T00:00:00Z' } }),
    ]);

    // 時刻の取れないカードは末尾
    expect(ids(sections.inbox)).toEqual(['old', 'pr', 'mid', 'new', 'unknown']);
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
  it('止まっているカードは止まりの起点の時刻', () => {
    const card = makeCard({
      id: 'a',
      stage: 'impling',
      latestReview: { at: '2026-09-20T00:00:00Z' },
      hold: { reason: '止まっている', since: '2026-09-24T00:00:00Z' },
    });

    expect(waitingSince(card)).toBe('2026-09-24T00:00:00Z');
  });

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
// 判断のボタン
// ============================================================

function decisionCard(overrides: Partial<DecisionCard> = {}): DecisionCard {
  return {
    stage: 'idea',
    aborted: false,
    hold: null,
    gates: { plan: 'none' },
    ...overrides,
  };
}

const HOLD = { reason: '止まっている', since: '2026-09-20T00:00:00Z' };

/** ボタンを `gate kind ラベル` の文字列に縮める。並びも確かめる */
const buttons = (card: DecisionCard): string[] =>
  decisionsFor(card).map((decision) => `${decision.gate} ${decision.kind} ${decision.label}`);

describe('decisionsFor', () => {
  it('計画レビューは plan の 承認 / 否決 / 中止', () => {
    expect(buttons(decisionCard({ stage: 'plan-review' }))).toEqual([
      'plan 承認 承認',
      'plan 否決 否決して差し戻す',
      'plan 中止 中止する',
    ]);
  });

  it('実装中で止まっていれば（PR が Draft に戻された）、計画から立て直させる / 中止', () => {
    const card = decisionCard({ stage: 'impling', hold: HOLD, gates: { plan: 'approved' } });

    expect(buttons(card)).toEqual(['plan 否決 計画から立て直させる', 'plan 中止 中止する']);
  });

  it('計画提案中で plan 保留なら、計画を直させる / 中止', () => {
    const card = decisionCard({ stage: 'planning', hold: HOLD, gates: { plan: 'held' } });

    expect(buttons(card)).toEqual(['plan 否決 計画を直させる', 'plan 中止 中止する']);
  });

  it('計画提案中で提出済みなのに成果物が見えなければ、中止だけ', () => {
    const card = decisionCard({ stage: 'planning', hold: HOLD, gates: { plan: 'submitted' } });

    expect(buttons(card)).toEqual(['plan 中止 中止する']);
  });

  it('否決はどれも理由が要り、承認と中止は要らない', () => {
    for (const stage of ['plan-review', 'impling'] as const) {
      for (const decision of decisionsFor(decisionCard({ stage, hold: HOLD }))) {
        expect(decision.reasonRequired).toBe(decision.kind === '否決');
      }
    }
  });

  it('止まっていない AI の列、アイデア、PR中、マージ済みには出さない', () => {
    for (const stage of ['idea', 'planning', 'impling', 'pr', 'merged'] as const) {
      expect(decisionsFor(decisionCard({ stage }))).toEqual([]);
    }
  });

  it('PR中 は止まりがあっても GitHub で判断するので出さない', () => {
    expect(decisionsFor(decisionCard({ stage: 'pr', hold: HOLD }))).toEqual([]);
  });

  it('中止のカードには、ゲートを待つ列でも止まっていても出さない', () => {
    for (const stage of ['plan-review', 'impling', 'planning'] as const) {
      expect(decisionsFor(decisionCard({ stage, hold: HOLD, aborted: true }))).toEqual([]);
    }
  });

  it('plan を飛ばすカードが実装中で止まっても、計画から立て直させるを出す', () => {
    // plan を飛ばすカードの plan ゲートは、AI の plan 提出 を承認と読んだ approved
    const card = {
      ...decisionCard({ stage: 'impling', hold: HOLD, gates: { plan: 'approved' } }),
      skipGates: ['plan'],
    };

    expect(buttons(card)).toEqual(['plan 否決 計画から立て直させる', 'plan 中止 中止する']);
  });
});

describe('awaitsDecision', () => {
  it('計画レビューのカードは判断を待っている', () => {
    expect(awaitsDecision(decisionCard({ stage: 'plan-review' }))).toBe(true);
  });

  it('AI の列で止まっているカードは判断を待っている', () => {
    expect(awaitsDecision(decisionCard({ stage: 'impling', hold: HOLD }))).toBe(true);
    expect(awaitsDecision(decisionCard({ stage: 'planning', hold: HOLD }))).toBe(true);
  });

  it('PR中 のカードは GitHub で判断するので含めない', () => {
    expect(awaitsDecision(decisionCard({ stage: 'pr' }))).toBe(false);
  });

  it('中止のカードはゲートを待つ列に残っていても、止まっていても含めない', () => {
    for (const stage of ['plan-review', 'impling'] as const) {
      expect(awaitsDecision(decisionCard({ stage, hold: HOLD, aborted: true }))).toBe(false);
    }
  });

  it('止まっていない AI の列とアイデアのカードは含めない', () => {
    for (const stage of ['idea', 'planning', 'impling', 'merged'] as const) {
      expect(awaitsDecision(decisionCard({ stage }))).toBe(false);
    }
  });
});

// ============================================================
// 動きなし
// ============================================================

describe('isStale', () => {
  const now = new Date('2026-09-26T00:00:00Z');

  it('PR の指摘に応えるカードは、計画が古くても動きなしと読まない', () => {
    const card = makeCard({
      id: 'fixing',
      stage: 'pr',
      plan: { updatedAt: '2026-01-01T00:00:00Z' },
      mrState: mr({ awaitingFix: true }),
    });

    expect(isStale(card, new Date('2026-11-04T00:00:00Z'))).toBe(false);
  });

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
