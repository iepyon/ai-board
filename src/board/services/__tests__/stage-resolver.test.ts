import { describe, it, expect } from 'vitest';
import {
  HUMAN_STAGES,
  droppableStages,
  resolveFloorStage,
  resolveStage,
} from '../stage-resolver.js';
import type { Card } from '../../../cards/models/card.js';
import type { OpenSpecChangeState } from '../../models/openspec-state.js';
import type { MrState } from '../../models/mr-state.js';
import type { CardId, ChangeName, MergeRequestIid, Stage } from '../../../shared/schemas/common.js';

// ============================================================
// テストデータビルダー
// ============================================================

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'refresh-token' as CardId,
    title: 'リフレッシュトークン対応',
    created: '2026-09-01T00:00:00.000Z',
    explored: false,
    implStartedAt: null,
    change: 'refresh-token' as ChangeName,
    branch: null,
    mr: null,
    stageOverride: null,
    body: '',
    ...overrides,
  };
}

function makeOpenSpec(overrides: Partial<OpenSpecChangeState> = {}): OpenSpecChangeState {
  return {
    name: 'refresh-token' as ChangeName,
    artifacts: { proposal: false, specs: false, design: false, tasks: false },
    tasks: { completed: 0, total: 0 },
    archived: false,
    archivedAs: null,
    ...overrides,
  };
}

function makeMr(overrides: Partial<MrState> = {}): MrState {
  return {
    iid: 42 as MergeRequestIid,
    state: 'opened',
    sourceBranch: 'feat/refresh-token',
    title: 'リフレッシュトークン対応',
    webUrl: 'http://localhost:8080/g/p/-/merge_requests/42',
    latestNoteAt: null,
    noteCount: 0,
    latestCommitAt: null,
    ...overrides,
  };
}

// ============================================================
// 7 ステージの導出
// ============================================================

describe('resolveStage — 自動導出', () => {
  const cases: ReadonlyArray<{
    name: string;
    card: Card;
    openspec: OpenSpecChangeState | null;
    mr: MrState | null;
    expected: Stage;
  }> = [
    {
      name: '何の実態も無ければ idea',
      card: makeCard(),
      openspec: null,
      mr: null,
      expected: 'idea',
    },
    {
      name: 'explored フラグが立てば explored',
      card: makeCard({ explored: true }),
      openspec: null,
      mr: null,
      expected: 'explored',
    },
    {
      name: 'proposal.md があれば proposed',
      card: makeCard({ explored: true }),
      openspec: makeOpenSpec({
        artifacts: { proposal: true, specs: false, design: false, tasks: false },
      }),
      mr: null,
      expected: 'proposed',
    },
    {
      name: 'implStartedAt が打刻されていれば impling',
      card: makeCard({ implStartedAt: '2026-09-04T10:12:00.000Z' }),
      openspec: makeOpenSpec({
        artifacts: { proposal: true, specs: true, design: false, tasks: true },
      }),
      mr: null,
      expected: 'impling',
    },
    {
      name: 'MR がオープンなら ai-pr',
      card: makeCard({ implStartedAt: '2026-09-04T10:12:00.000Z' }),
      openspec: makeOpenSpec({
        artifacts: { proposal: true, specs: true, design: false, tasks: true },
      }),
      mr: makeMr(),
      expected: 'ai-pr',
    },
    {
      name: 'レビュー後に修正コミットがあれば ai-pr-fixed',
      card: makeCard(),
      openspec: null,
      mr: makeMr({
        latestNoteAt: '2026-09-04T10:00:00.000Z',
        noteCount: 2,
        latestCommitAt: '2026-09-04T10:30:00.000Z',
      }),
      expected: 'ai-pr-fixed',
    },
    {
      name: 'archive にあれば done',
      card: makeCard(),
      openspec: makeOpenSpec({ archived: true, archivedAs: '2026-09-01-refresh-token' }),
      mr: null,
      expected: 'done',
    },
    {
      name: 'MR がマージ済みなら done',
      card: makeCard(),
      openspec: makeOpenSpec({
        artifacts: { proposal: true, specs: false, design: false, tasks: false },
      }),
      mr: makeMr({ state: 'merged' }),
      expected: 'done',
    },
  ];

  it.each(cases)('$name', ({ card, openspec, mr, expected }) => {
    expect(resolveStage(card, openspec, mr).stage).toBe(expected);
  });

  it('最も進んだステージが勝つ（archive は MR オープンより優先）', () => {
    const result = resolveStage(
      makeCard({ explored: true, implStartedAt: '2026-09-04T10:00:00.000Z' }),
      makeOpenSpec({ archived: true, archivedAs: '2026-09-01-refresh-token' }),
      makeMr()
    );

    expect(result.stage).toBe('done');
  });
});

// ============================================================
// ai-pr-fixed の境界条件
// ============================================================

describe('resolveStage — ai-pr-fixed の判定', () => {
  it('レビューコメントが 1 件も無ければ ai-pr-fixed にはならない', () => {
    const result = resolveStage(
      makeCard(),
      null,
      makeMr({ latestNoteAt: null, noteCount: 0, latestCommitAt: '2026-09-04T10:30:00.000Z' })
    );

    expect(result.stage).toBe('ai-pr');
  });

  it('コミットがレビューコメントより古ければ ai-pr のまま', () => {
    const result = resolveStage(
      makeCard(),
      null,
      makeMr({
        latestNoteAt: '2026-09-04T11:00:00.000Z',
        noteCount: 1,
        latestCommitAt: '2026-09-04T10:30:00.000Z',
      })
    );

    expect(result.stage).toBe('ai-pr');
  });

  it('新しいコメントが来ると ai-pr-fixed から ai-pr へ戻る', () => {
    const fixed = makeMr({
      latestNoteAt: '2026-09-04T10:00:00.000Z',
      noteCount: 1,
      latestCommitAt: '2026-09-04T10:30:00.000Z',
    });
    expect(resolveStage(makeCard(), null, fixed).stage).toBe('ai-pr-fixed');

    const reReviewed = { ...fixed, latestNoteAt: '2026-09-04T11:00:00.000Z', noteCount: 2 };
    expect(resolveStage(makeCard(), null, reReviewed).stage).toBe('ai-pr');
  });

  it('同時刻なら修正とみなさない（厳密に後のコミットのみ）', () => {
    const result = resolveStage(
      makeCard(),
      null,
      makeMr({
        latestNoteAt: '2026-09-04T10:00:00.000Z',
        noteCount: 1,
        latestCommitAt: '2026-09-04T10:00:00.000Z',
      })
    );

    expect(result.stage).toBe('ai-pr');
  });

  it('日時が壊れていても例外にせず ai-pr のまま扱う', () => {
    const result = resolveStage(
      makeCard(),
      null,
      makeMr({ latestNoteAt: 'not-a-date', noteCount: 1, latestCommitAt: 'also-broken' })
    );

    expect(result.stage).toBe('ai-pr');
  });

  it('クローズされた MR は ai-pr にも done にもならず後段の実態に従う', () => {
    const result = resolveStage(
      makeCard({ implStartedAt: '2026-09-04T10:00:00.000Z' }),
      null,
      makeMr({ state: 'closed' })
    );

    expect(result.stage).toBe('impling');
  });
});

// ============================================================
// 手動上書きと乖離
// ============================================================

describe('resolveStage — 手動上書き', () => {
  it('上書きがあれば自動導出より優先される', () => {
    const result = resolveStage(makeCard({ stageOverride: 'done' }), null, null);

    expect(result.stage).toBe('done');
    expect(result.derived).toBe('idea');
    expect(result.overridden).toBe(true);
  });

  it('上書きが自動導出と食い違えば diverged が立つ', () => {
    const result = resolveStage(
      makeCard({ stageOverride: 'done' }),
      makeOpenSpec({
        artifacts: { proposal: true, specs: false, design: false, tasks: false },
      }),
      null
    );

    expect(result.diverged).toBe(true);
    expect(result.derived).toBe('proposed');
  });

  it('上書きと自動導出が一致すれば diverged は立たない', () => {
    const result = resolveStage(
      makeCard({ stageOverride: 'proposed' }),
      makeOpenSpec({
        artifacts: { proposal: true, specs: false, design: false, tasks: false },
      }),
      null
    );

    expect(result.overridden).toBe(true);
    expect(result.diverged).toBe(false);
  });

  it('上書きが無ければ overridden も diverged も false', () => {
    const result = resolveStage(makeCard(), null, null);

    expect(result.overridden).toBe(false);
    expect(result.diverged).toBe(false);
  });

  it('reason は上書きの有無にかかわらず自動導出の理由を返す', () => {
    const result = resolveStage(
      makeCard({ stageOverride: 'idea' }),
      makeOpenSpec({ archived: true, archivedAs: '2026-09-01-refresh-token' }),
      null
    );

    expect(result.reason).toContain('2026-09-01-refresh-token');
  });
});

// ============================================================
// tasks 進捗はステージ判定に使わない
// ============================================================

describe('resolveStage — tasks 進捗はステージに影響しない', () => {
  it('tasks が全完了でも proposed のまま（impling へは進めない）', () => {
    const result = resolveStage(
      makeCard(),
      makeOpenSpec({
        artifacts: { proposal: true, specs: true, design: true, tasks: true },
        tasks: { completed: 8, total: 8 },
      }),
      null
    );

    expect(result.stage).toBe('proposed');
  });
});

// ============================================================
// floorStage — AI の成果物が課す下限
// ============================================================

describe('resolveFloorStage', () => {
  const cases: ReadonlyArray<{
    name: string;
    openspec: OpenSpecChangeState | null;
    mr: MrState | null;
    expected: Stage;
  }> = [
    { name: 'AI の成果物が何も無ければ idea', openspec: null, mr: null, expected: 'idea' },
    {
      name: 'proposal.md があれば proposed',
      openspec: makeOpenSpec({
        artifacts: { proposal: true, specs: false, design: false, tasks: false },
      }),
      mr: null,
      expected: 'proposed',
    },
    { name: 'MR がオープンなら ai-pr', openspec: null, mr: makeMr(), expected: 'ai-pr' },
    {
      name: 'レビュー後の修正があれば ai-pr-fixed',
      openspec: null,
      mr: makeMr({
        latestNoteAt: '2026-09-04T10:00:00.000Z',
        noteCount: 1,
        latestCommitAt: '2026-09-04T10:30:00.000Z',
      }),
      expected: 'ai-pr-fixed',
    },
    {
      name: 'archive にあれば done',
      openspec: makeOpenSpec({ archived: true, archivedAs: '2026-09-01-refresh-token' }),
      mr: null,
      expected: 'done',
    },
  ];

  it.each(cases)('$name', ({ openspec, mr, expected }) => {
    expect(resolveFloorStage(makeCard(), openspec, mr)).toBe(expected);
  });

  it('カード側のフラグは下限に影響しない', () => {
    const flagged = makeCard({ explored: true, implStartedAt: '2026-09-04T10:00:00.000Z' });

    expect(resolveFloorStage(flagged, null, null)).toBe('idea');
  });

  it('手動上書きは下限に影響しない', () => {
    expect(resolveFloorStage(makeCard({ stageOverride: 'done' }), null, null)).toBe('idea');
  });
});

// ============================================================
// droppableStages — 手で入れられる列
// ============================================================

describe('droppableStages', () => {
  const cases: ReadonlyArray<{ floor: Stage; expected: Stage[] }> = [
    { floor: 'idea', expected: ['idea', 'explored', 'impling'] },
    // AI が提案を書いたら、人は着手を指示できるがアイデアには戻せない
    { floor: 'proposed', expected: ['impling'] },
    // MR ができたら AI の領分
    { floor: 'ai-pr', expected: [] },
    { floor: 'ai-pr-fixed', expected: [] },
    { floor: 'done', expected: [] },
  ];

  it.each(cases)('下限が $floor なら $expected へ落とせる', ({ floor, expected }) => {
    expect(droppableStages(floor)).toEqual(expected);
  });

  it('AI が決める列は決してドロップ先にならない', () => {
    const aiStages: Stage[] = ['proposed', 'ai-pr', 'ai-pr-fixed', 'done'];

    for (const floor of ['idea', 'proposed', 'ai-pr', 'done'] as Stage[]) {
      for (const target of droppableStages(floor)) {
        expect(aiStages).not.toContain(target);
      }
    }
  });

  it('人の列は explored フラグと implStartedAt で表せるものだけ', () => {
    expect(HUMAN_STAGES).toEqual(['idea', 'explored', 'impling']);
  });
});
