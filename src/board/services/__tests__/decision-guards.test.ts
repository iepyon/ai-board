import { describe, it, expect } from 'vitest';
import type { CardId } from '../../../shared/schemas/common.js';
import { DIVIDER_ID } from '../../../shared/card-reorder.js';
import type { Board, BoardCard } from '../../models/board-card.js';
import type { ForgeConnection } from '../../models/mr-state.js';
import {
  guardMove,
  guardMoveDivider,
  guardReview,
  guardSkip,
  guardStartedAt,
} from '../decision-guards.js';

// ============================================================
// テスト用のボード。検査が読むフィールドだけを意味のある値にする
// ============================================================

function card(id: string, overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id,
    title: id,
    created: '2026-11-01T00:00:00.000Z',
    stage: 'idea',
    reason: '',
    aborted: false,
    gates: { plan: 'none' },
    latestReview: null,
    floorStage: 'idea',
    droppableStages: ['idea', 'planning'],
    startedAt: null,
    skipGates: [],
    branch: null,
    mr: null,
    rank: null,
    body: '',
    reviews: [],
    plan: null,
    mrState: null,
    hold: null,
    timeline: [],
    loopSteps: [],
    ...overrides,
  };
}

const CONNECTED: ForgeConnection = { status: 'connected', kind: 'github' };
const DISCONNECTED: ForgeConnection = { status: 'error', kind: 'github', message: 'gh が失敗した' };

function board(cards: readonly BoardCard[], forge: ForgeConnection = CONNECTED): Board {
  return {
    cards,
    forge,
    orphanPlans: [],
    ideaDivider: null,
    loop: { running: [], lastFinishedAt: null },
    generatedAt: '2026-11-06T00:00:00.000Z',
  };
}

const id = (value: string): CardId => value as CardId;

const REVIEWING = card('r', {
  stage: 'plan-review',
  gates: { plan: 'submitted' },
  startedAt: '2026-11-02T00:00:00.000Z',
  droppableStages: [],
});

// ============================================================
// 承認 / 否決 / 中止
// ============================================================

describe('guardReview', () => {
  it('出ている判断なら、書く先のカードとゲートを返す', () => {
    const result = guardReview(board([REVIEWING]), { id: id('r'), kind: '承認', reason: '' });

    expect(result).toEqual({ ok: true, value: { card: REVIEWING, gate: 'plan' } });
  });

  it('GitHub に繋がらなければ ForgeUnavailable で拒む', () => {
    const result = guardReview(board([REVIEWING], DISCONNECTED), {
      id: id('r'),
      kind: '承認',
      reason: '',
    });

    expect(result).toEqual({
      ok: false,
      error: { type: 'ForgeUnavailable', action: 'review', forge: DISCONNECTED },
    });
  });

  it('カードが無ければ CardNotFound で拒む', () => {
    const result = guardReview(board([]), { id: id('x'), kind: '承認', reason: '' });

    expect(result).toEqual({ ok: false, error: { type: 'CardNotFound', id: 'x' } });
  });

  it('出ていない判断は DecisionUnavailable で拒み、カードを添える', () => {
    const planning = card('p', { stage: 'planning', startedAt: '2026-11-02T00:00:00.000Z' });

    const result = guardReview(board([planning]), { id: id('p'), kind: '承認', reason: '' });

    expect(result).toEqual({
      ok: false,
      error: { type: 'DecisionUnavailable', id: 'p', kind: '承認', card: planning },
    });
  });

  it('否決は空白だけの理由を ReasonRequired で拒む', () => {
    const result = guardReview(board([REVIEWING]), { id: id('r'), kind: '否決', reason: '  ' });

    expect(result).toEqual({ ok: false, error: { type: 'ReasonRequired', kind: '否決' } });
  });
});

// ============================================================
// 着手 / 着手を戻す
// ============================================================

describe('guardStartedAt', () => {
  const idea = card('i');

  it('今の列が from で、to へ入れられるカードを返す', () => {
    const result = guardStartedAt(board([idea]), { id: id('i'), from: 'idea', to: 'planning' });

    expect(result).toEqual({ ok: true, value: idea });
  });

  it('GitHub に繋がらなければ ForgeUnavailable で拒む', () => {
    const result = guardStartedAt(board([idea], DISCONNECTED), {
      id: id('i'),
      from: 'idea',
      to: 'planning',
    });

    expect(result).toEqual({
      ok: false,
      error: { type: 'ForgeUnavailable', action: 'startedAt', forge: DISCONNECTED },
    });
  });

  it('今の列が from でなければ StageMismatch で拒む', () => {
    const result = guardStartedAt(board([REVIEWING]), {
      id: id('r'),
      from: 'planning',
      to: 'idea',
    });

    expect(result).toEqual({
      ok: false,
      error: { type: 'StageMismatch', id: 'r', from: 'planning', to: 'idea', card: REVIEWING },
    });
  });

  it('to へ入れられなければ StageMismatch で拒む', () => {
    const pinned = card('p', {
      stage: 'planning',
      startedAt: '2026-11-02T00:00:00.000Z',
      droppableStages: ['planning'],
    });

    const result = guardStartedAt(board([pinned]), { id: id('p'), from: 'planning', to: 'idea' });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.type).toBe('StageMismatch');
  });

  it('カードが無ければ CardNotFound で拒む', () => {
    const result = guardStartedAt(board([]), { id: id('x'), from: 'idea', to: 'planning' });

    expect(result).toEqual({ ok: false, error: { type: 'CardNotFound', id: 'x' } });
  });
});

// ============================================================
// 飛ばす宣言
// ============================================================

describe('guardSkip', () => {
  it('中止していないカードは、GitHub に繋がらなくても返す', () => {
    const result = guardSkip(board([REVIEWING], DISCONNECTED), { id: id('r') });

    expect(result).toEqual({ ok: true, value: REVIEWING });
  });

  it('中止したカードは CardAborted で拒む', () => {
    const aborted = card('a', { aborted: true });

    const result = guardSkip(board([aborted]), { id: id('a') });

    expect(result).toEqual({ ok: false, error: { type: 'CardAborted', id: 'a' } });
  });

  it('カードが無ければ CardNotFound で拒む', () => {
    const result = guardSkip(board([]), { id: id('x') });

    expect(result).toEqual({ ok: false, error: { type: 'CardNotFound', id: 'x' } });
  });
});

// ============================================================
// 並べ替え
// ============================================================

describe('guardMove / guardMoveDivider', () => {
  const ideas = board([card('a'), card('b'), REVIEWING]);

  it('アイデアの表に並ぶカード・区切り線・端の間へは動かせる', () => {
    expect(guardMove(ideas, { id: id('a'), after: 'b', before: DIVIDER_ID }).ok).toBe(true);
    expect(guardMove(ideas, { id: id('a'), after: null, before: 'b' }).ok).toBe(true);
    expect(guardMoveDivider(ideas, { after: 'a', before: 'b' }).ok).toBe(true);
    expect(guardMoveDivider(ideas, { after: null, before: null }).ok).toBe(true);
  });

  it('アイデアの表に無いカードを動かす・隣に指定するのは NotInIdeaTable で拒む', () => {
    expect(guardMove(ideas, { id: id('r'), after: null, before: 'a' })).toEqual({
      ok: false,
      error: { type: 'NotInIdeaTable', ref: 'r' },
    });
    expect(guardMove(ideas, { id: id('a'), after: 'missing', before: null })).toEqual({
      ok: false,
      error: { type: 'NotInIdeaTable', ref: 'missing' },
    });
  });

  it('区切り線を動かすときは、区切り線を隣に指定できない', () => {
    expect(guardMoveDivider(ideas, { after: DIVIDER_ID, before: 'a' })).toEqual({
      ok: false,
      error: { type: 'NotInIdeaTable', ref: DIVIDER_ID },
    });
  });
});
