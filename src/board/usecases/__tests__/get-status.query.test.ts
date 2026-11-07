import { describe, it, expect } from 'vitest';
import type { Card } from '../../../cards/models/card.js';
import type { CardRepository } from '../../../cards/repositories/card.repository.js';
import type { IdeaDividerRepository } from '../../../cards/repositories/idea-divider.repository.js';
import { err } from '../../../shared/result.js';
import type { CardId, MergeRequestIid } from '../../../shared/schemas/common.js';
import type { BranchPlanRepository } from '../../repositories/branch-plan.repository.js';
import type { PlanRepository } from '../../repositories/plan.repository.js';
import type { MrStateProvider } from '../../services/mr-state-provider.js';
import type { ImplStepPlan } from '../../services/impl-step.js';
import { createGetBoardQuery, type GetBoardQuery } from '../queries/get-board.query.js';
import { createGetStatusQuery } from '../queries/get-status.query.js';

const NOW = new Date('2026-11-06T00:00:00.000Z');

/** 計画が承認された、実装中のカード（`next` は implement になる） */
function implementing(branch: string | null): Card {
  return {
    id: 'impl' as CardId,
    title: 'impl のタイトル',
    created: '2026-11-01T00:00:00.000Z',
    startedAt: '2026-11-02T00:00:00.000Z',
    skipGates: [],
    branch,
    mr: null,
    rank: null,
    body: '## レビュー\n\n### 2026-11-03T00:00:00.000Z plan 承認\n',
  };
}

const connected: MrStateProvider = {
  get: () => null,
  connection: () => ({ status: 'connected', kind: 'github' }),
  synced: () => true,
  failure: () => null,
};

/** `github:` が無い（未設定）。`disabledMrStateProvider` と同じ形 */
const unset: MrStateProvider = {
  get: () => null,
  connection: () => ({ status: 'disabled', kind: null, reason: null }),
  synced: () => false,
  failure: () => null,
};

/** `github:` はあるが、gh が無い・未ログイン・届かない */
const unavailable: MrStateProvider = {
  ...unset,
  connection: () => ({ status: 'disabled', kind: 'github', reason: 'gh が無い' }),
};

function boardQuery(cards: readonly Card[], provider: MrStateProvider = connected): GetBoardQuery {
  const cardRepository: Pick<CardRepository, 'findAll'> = {
    findAll: () => Promise.resolve([...cards]),
  };
  const ideaDividerRepository: Pick<IdeaDividerRepository, 'get'> = {
    get: () => Promise.resolve(null),
  };
  const planRepository: PlanRepository = { load: () => Promise.resolve(new Map()) };

  return createGetBoardQuery(
    cardRepository as CardRepository,
    ideaDividerRepository as IdeaDividerRepository,
    planRepository,
    provider,
    { findAll: () => Promise.resolve([]) }
  );
}

/** 読み手の偽物。呼ばれた引数を控え、決めた計画を返す */
function planReader(plan: ImplStepPlan | null): BranchPlanRepository & {
  readonly calls: Array<[string, string]>;
} {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    find: (cardId, branch) => {
      calls.push([cardId, branch]);
      return Promise.resolve(plan);
    },
  };
}

describe('GetStatusQuery', () => {
  it('implement の手では、選ばれたカードのブランチの計画から next.step を埋める', async () => {
    const reader = planReader({ location: 'active', text: '- [x] 1\n- [ ] 2\n' });

    const result = await createGetStatusQuery(
      boardQuery([implementing('impl-branch')]),
      reader
    )(NOW);

    if (!result.ok) throw new Error('ボードを読めない');
    expect(result.value.next).toMatchObject({ cardId: 'impl', action: 'implement', step: 'task' });
    expect(reader.calls).toEqual([['impl', 'impl-branch']]);
  });

  it('読み手を渡さなければ、implement でも next.step は null', async () => {
    const result = await createGetStatusQuery(boardQuery([implementing('impl-branch')]))(NOW);

    if (!result.ok) throw new Error('ボードを読めない');
    expect(result.value.next).toMatchObject({ action: 'implement', step: null });
  });

  it('カードの branch が null なら、読み手を呼ばずに next.step は null', async () => {
    const reader = planReader({ location: 'active', text: '- [ ] 1\n' });

    const result = await createGetStatusQuery(boardQuery([implementing(null)]), reader)(NOW);

    if (!result.ok) throw new Error('ボードを読めない');
    expect(result.value.next).toMatchObject({ action: 'implement', step: null });
    expect(reader.calls).toEqual([]);
  });

  it('GitHub が未設定なら、接続済みと同じに次の一手を出す', async () => {
    const result = await createGetStatusQuery(boardQuery([implementing(null)], unset))(NOW);

    expect(result.ok && result.value.next).toMatchObject({ cardId: 'impl', action: 'implement' });
  });

  it('GitHub が未設定なら、PR 番号を持つカードを飛ばして次のカードを選ぶ', async () => {
    const withPr: Card = {
      ...implementing(null),
      id: 'with-pr' as CardId,
      mr: 7 as MergeRequestIid,
    };
    const result = await createGetStatusQuery(boardQuery([withPr, implementing(null)], unset))(NOW);
    if (!result.ok) throw new Error('ボードを読めない');

    expect(result.value.next?.cardId).toBe('impl');
    expect(result.value.waiting.map((card) => card.id)).toEqual(['with-pr']);
  });

  it('github: があって使えなければ、次の一手を出さない', async () => {
    const result = await createGetStatusQuery(boardQuery([implementing(null)], unavailable))(NOW);

    expect(result.ok && result.value.next).toBeNull();
  });

  it('ボードを読めなければ、そのエラーをそのまま返す', async () => {
    const failing: GetBoardQuery = () =>
      Promise.resolve(err({ type: 'BoardUnreadable', reason: '読めない' }));

    const result = await createGetStatusQuery(failing, planReader(null))(NOW);

    expect(result).toEqual(err({ type: 'BoardUnreadable', reason: '読めない' }));
  });
});
