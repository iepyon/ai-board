import { describe, it, expect } from 'vitest';
import type { Card } from '../../../cards/models/card.js';
import type { CardRepository } from '../../../cards/repositories/card.repository.js';
import type { IdeaDividerRepository } from '../../../cards/repositories/idea-divider.repository.js';
import type { CardId, PullRequestNumber } from '../../../shared/schemas/common.js';
import type { LoopStep } from '../../models/loop-step.js';
import type { LoopHistoryRepository } from '../../repositories/loop-history.repository.js';
import type { PlanRepository } from '../../repositories/plan.repository.js';
import {
  emptyBranchPlanRepository,
  type BranchPlanRepository,
} from '../../repositories/branch-plan.repository.js';
import type { PlanDoc, PlanState } from '../../models/plan-state.js';
import { createCardId } from '../../../shared/schemas/common.js';
import {
  disabledPrStateProvider,
  unavailablePrStateProvider,
  type PrStateProvider,
} from '../../services/pr-state-provider.js';
import { createGetBoardQuery } from '../queries/get-board.query.js';

function card(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id: id as CardId,
    title: `${id} のタイトル`,
    created: '2026-11-01T00:00:00.000Z',
    startedAt: '2026-11-02T00:00:00.000Z',
    skipGates: [],
    branch: null,
    pr: null,
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
    startedAt: '2026-11-02T01:00:00.000Z',
    finishedAt: '2026-11-02T02:00:00.000Z',
    result: 'stopped',
    ...overrides,
  };
}

function query(
  cards: readonly Card[],
  steps: readonly LoopStep[],
  provider: PrStateProvider = disabledPrStateProvider,
  branchPlans?: BranchPlanRepository,
  mainPlans: PlanState = new Map()
) {
  const cardRepository: Pick<CardRepository, 'findAll'> = {
    findAll: () => Promise.resolve([...cards]),
  };
  const ideaDividerRepository: Pick<IdeaDividerRepository, 'get'> = {
    get: () => Promise.resolve(null),
  };
  const planRepository: PlanRepository = { load: () => Promise.resolve(mainPlans) };
  const loopHistoryRepository: LoopHistoryRepository = {
    findAll: () => Promise.resolve([...steps]),
  };

  return createGetBoardQuery(
    cardRepository as CardRepository,
    ideaDividerRepository as IdeaDividerRepository,
    planRepository,
    provider,
    loopHistoryRepository,
    branchPlans
  );
}

describe('GetBoardQuery のループの記録', () => {
  it('カードごとに手の一覧を分け、ループの様子をまとめる', async () => {
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
      disabledPrStateProvider,
      { findAll: () => Promise.reject(new Error('壊れた')) }
    );
    const result = await q();
    expect(!result.ok && result.error).toEqual({ type: 'BoardUnreadable', reason: '壊れた' });
  });
});

describe('GetBoardQuery の GitHub が未設定のボード', () => {
  // どちらも計画提案中（着手済みで、まだ提出していない）。止まらなければ アイデア / 計画提案中 へ動かせる
  const withPr = card('with-pr', { pr: 7 as PullRequestNumber });
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
    const result = await query([withPr], [], unavailablePrStateProvider('github', 'gh が無い'))();
    if (!result.ok) throw new Error('ボードを読めない');

    expect(result.value.cards[0]?.hold).toBeNull();
  });
});

describe('GetBoardQuery のブランチの計画', () => {
  const submitted = card('submitted', {
    branch: 'submitted',
    body: '## レビュー\n\n### 2026-11-03T00:00:00.000Z plan 提出\n\n理由\n',
  });
  const branchDoc: PlanDoc = {
    cardId: createCardId('submitted'),
    tasks: { completed: 0, total: 2 },
    archived: false,
    updatedAt: '2026-11-03T00:00:00.000Z',
  };

  function reader(): BranchPlanRepository & { readonly calls: string[] } {
    const calls: string[] = [];
    return {
      ...emptyBranchPlanRepository,
      calls,
      findActive: (cardId) => {
        calls.push(cardId);
        return Promise.resolve(cardId === 'submitted' ? branchDoc : null);
      },
    };
  }

  it('未設定のボードでは、ブランチの計画で計画レビューを立てる', async () => {
    const branchPlans = reader();
    const result = await query([submitted], [], disabledPrStateProvider, branchPlans)();
    if (!result.ok) throw new Error('ボードを読めない');

    expect(result.value.cards[0]?.stage).toBe('plan-review');
    expect(result.value.cards[0]?.plan?.tasks).toEqual({ completed: 0, total: 2 });
    expect(branchPlans.calls).toEqual(['submitted']);
  });

  it('github: があるボードではブランチを読まない', async () => {
    const branchPlans = reader();
    const unavailable = unavailablePrStateProvider('github', 'gh が無い');
    const result = await query([submitted], [], unavailable, branchPlans)();
    if (!result.ok) throw new Error('ボードを読めない');

    expect(result.value.cards[0]?.stage).toBe('planning');
    expect(branchPlans.calls).toEqual([]);
  });

  it('メインの計画があれば、ブランチを読まずにそちらを使う', async () => {
    const branchPlans = reader();
    const main: PlanDoc = { ...branchDoc, tasks: { completed: 1, total: 1 } };
    const result = await query(
      [submitted],
      [],
      disabledPrStateProvider,
      branchPlans,
      new Map([[main.cardId, main]])
    )();
    if (!result.ok) throw new Error('ボードを読めない');

    expect(result.value.cards[0]?.plan?.tasks).toEqual({ completed: 1, total: 1 });
    expect(branchPlans.calls).toEqual([]);
  });
});

describe('GetBoardQuery のブランチのマージ待ち', () => {
  const approved = card('closed', {
    branch: 'closed',
    body: '## レビュー\n\n### 2026-11-03T00:00:00.000Z plan 提出\n\n理由\n\n### 2026-11-03T01:00:00.000Z plan 承認\n\n',
  });
  const archivedAt = '2026-11-04T00:00:00.000Z';

  function reader(): BranchPlanRepository & { readonly calls: string[] } {
    const calls: string[] = [];
    return {
      ...emptyBranchPlanRepository,
      calls,
      findClosed: (cardId) => {
        calls.push(cardId);
        return Promise.resolve(cardId === 'closed' ? { archivedAt } : null);
      },
    };
  }

  it('未設定のボードでは、締めが済んだ実装中のカードをマージ待ちの止まりにする', async () => {
    const branchPlans = reader();
    const result = await query([approved], [], disabledPrStateProvider, branchPlans)();
    if (!result.ok) throw new Error('ボードを読めない');

    const closed = result.value.cards[0];
    expect(closed?.stage).toBe('impling');
    expect(closed?.hold).toEqual({
      kind: 'decision',
      reason: expect.stringContaining('git merge --no-ff closed') as string,
      since: archivedAt,
    });
    expect(branchPlans.calls).toEqual(['closed']);
  });

  it('github: があるボードではブランチの archive を読まない', async () => {
    const branchPlans = reader();
    const unavailable = unavailablePrStateProvider('github', 'gh が無い');
    const result = await query([approved], [], unavailable, branchPlans)();
    if (!result.ok) throw new Error('ボードを読めない');

    expect(result.value.cards[0]?.hold).toBeNull();
    expect(branchPlans.calls).toEqual([]);
  });

  it('メインに計画（archive）があれば、ブランチを読まずにマージ済みにする', async () => {
    const branchPlans = reader();
    const merged: PlanDoc = {
      cardId: createCardId('closed'),
      tasks: { completed: 1, total: 1 },
      archived: true,
      updatedAt: archivedAt,
    };
    const result = await query(
      [approved],
      [],
      disabledPrStateProvider,
      branchPlans,
      new Map([[merged.cardId, merged]])
    )();
    if (!result.ok) throw new Error('ボードを読めない');

    expect(result.value.cards[0]?.stage).toBe('merged');
    expect(result.value.cards[0]?.hold).toBeNull();
    expect(branchPlans.calls).toEqual([]);
  });
});
