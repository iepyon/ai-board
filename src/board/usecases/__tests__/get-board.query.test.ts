import { describe, it, expect } from 'vitest';
import type { Card } from '../../../cards/models/card.js';
import type { CardRepository } from '../../../cards/repositories/card.repository.js';
import type { IdeaDividerRepository } from '../../../cards/repositories/idea-divider.repository.js';
import type { CardId, MergeRequestIid } from '../../../shared/schemas/common.js';
import type { LoopStep } from '../../../shared/loop-step.js';
import type { LoopHistoryRepository } from '../../repositories/loop-history.repository.js';
import type { PlanRepository } from '../../repositories/plan.repository.js';
import {
  disabledMrStateProvider,
  unavailableMrStateProvider,
  type MrStateProvider,
} from '../../services/mr-state-provider.js';
import { createGetBoardQuery } from '../queries/get-board.query.js';

function card(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id: id as CardId,
    title: `${id} のタイトル`,
    created: '2026-11-01T00:00:00.000Z',
    startedAt: '2026-11-02T00:00:00.000Z',
    skipGates: [],
    branch: null,
    mr: null,
    rank: null,
    body: '',
    ...overrides,
  };
}

function step(overrides: Partial<LoopStep> = {}): LoopStep {
  return {
    loop: 'session-a',
    cardId: 'card-a',
    action: 'plan',
    step: null,
    agent: null,
    harness: null,
    startedAt: '2026-11-02T01:00:00.000Z',
    finishedAt: '2026-11-02T02:00:00.000Z',
    result: 'stopped',
    tokens: null,
    durationMs: null,
    ...overrides,
  };
}

function query(
  cards: readonly Card[],
  steps: readonly LoopStep[],
  provider: MrStateProvider = disabledMrStateProvider
) {
  const cardRepository: Pick<CardRepository, 'findAll'> = {
    findAll: () => Promise.resolve([...cards]),
  };
  const ideaDividerRepository: Pick<IdeaDividerRepository, 'get'> = {
    get: () => Promise.resolve(null),
  };
  const planRepository: PlanRepository = { load: () => Promise.resolve(new Map()) };
  const loopHistoryRepository: LoopHistoryRepository = {
    findAll: () => Promise.resolve([...steps]),
  };

  return createGetBoardQuery(
    cardRepository as CardRepository,
    ideaDividerRepository as IdeaDividerRepository,
    planRepository,
    provider,
    loopHistoryRepository
  );
}

describe('GetBoardQuery のループの記録', () => {
  it('カードごとに手の一覧を分け、ループの様子をまとめ、AI の区間を待ちと作業に分ける', async () => {
    const running = step({
      cardId: 'card-b',
      startedAt: '2026-11-02T03:00:00.000Z',
      finishedAt: null,
      result: null,
    });
    const result = await query(
      [card('card-a'), card('card-b')],
      [step(), running, step({ cardId: 'gone' })]
    )();
    if (!result.ok) throw new Error('ボードを読めない');
    const board = result.value;
    const [a, b] = board.cards;

    expect(a?.loopSteps).toEqual([step()]);
    expect(b?.loopSteps).toEqual([running]);
    expect(board.loop).toEqual({ running: [running], lastFinishedAt: '2026-11-02T02:00:00.000Z' });
    expect(a?.timeline.map((segment) => segment.phases.map((p) => p.kind))).toEqual([
      [],
      ['wait', 'work', 'wait'],
    ]);
  });

  it('記録はステージの導出に使わない', async () => {
    const without = await query([card('card-a')], [])();
    const withSteps = await query([card('card-a')], [step()])();
    if (!without.ok || !withSteps.ok) throw new Error('ボードを読めない');

    expect(withSteps.value.cards[0]?.stage).toBe(without.value.cards[0]?.stage);
    expect(withSteps.value.cards[0]?.hold).toEqual(without.value.cards[0]?.hold);
  });

  it('記録を読めなければ BoardUnreadable', async () => {
    const q = createGetBoardQuery(
      { findAll: () => Promise.resolve([]) } as unknown as CardRepository,
      { get: () => Promise.resolve(null) } as unknown as IdeaDividerRepository,
      { load: () => Promise.resolve(new Map()) },
      disabledMrStateProvider,
      { findAll: () => Promise.reject(new Error('壊れた')) }
    );
    const result = await q();
    expect(!result.ok && result.error).toEqual({ type: 'BoardUnreadable', reason: '壊れた' });
  });
});

describe('GetBoardQuery の GitHub が未設定のボード', () => {
  // どちらも計画提案中（着手済みで、まだ提出していない）。止まらなければ アイデア / 計画提案中 へ動かせる
  const withPr = card('with-pr', { mr: 7 as MergeRequestIid });
  const withoutPr = card('without-pr', { branch: 'without-pr' });

  it('PR 番号を持つカードだけを止まりにし、どの列へも動かさせない', async () => {
    const result = await query([withPr, withoutPr], [])();
    if (!result.ok) throw new Error('ボードを読めない');
    const [held, free] = result.value.cards;

    expect(held?.hold).toEqual({
      kind: 'forge',
      reason: expect.stringContaining('PR #7 を持つが、GitHub が未設定') as string,
      since: result.value.generatedAt,
    });
    expect(held?.droppableStages).toEqual([]);
    expect(free?.hold).toBeNull();
    expect(free?.droppableStages).toEqual(['idea', 'planning']);
  });

  it('github: があって使えないボードでは、PR 番号を持つカードを未設定の止まりにしない', async () => {
    const result = await query([withPr], [], unavailableMrStateProvider('github', 'gh が無い'))();
    if (!result.ok) throw new Error('ボードを読めない');

    expect(result.value.cards[0]?.hold).toBeNull();
  });
});
