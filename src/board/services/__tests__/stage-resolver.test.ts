import { describe, it, expect } from 'vitest';
import {
  HUMAN_STAGES,
  droppableStages,
  hasFixAfterReview,
  resolveFloorStage,
  resolveStage,
} from '../stage-resolver.js';
import type { Card } from '../../../cards/models/card.js';
import type { PlanDoc } from '../../models/plan-state.js';
import type { MrState } from '../../models/mr-state.js';
import type { CardId, MergeRequestIid, Stage } from '../../../shared/schemas/common.js';

// ============================================================
// テストデータビルダー
// ============================================================

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'refresh-token' as CardId,
    title: 'リフレッシュトークン対応',
    created: '2026-09-01T00:00:00.000Z',
    startedAt: null,
    skipGates: [],
    branch: null,
    mr: null,
    body: '',
    ...overrides,
  };
}

function makePlan(overrides: Partial<PlanDoc> = {}): PlanDoc {
  return {
    cardId: 'refresh-token' as CardId,
    tasks: { completed: 0, total: 0 },
    archived: false,
    ...overrides,
  };
}

function makeMr(overrides: Partial<MrState> = {}): MrState {
  return {
    forge: 'github',
    iid: 42 as MergeRequestIid,
    state: 'opened',
    sourceBranch: 'feat/refresh-token',
    title: 'リフレッシュトークン対応',
    webUrl: 'http://localhost:8929/g/p/-/merge_requests/42',
    latestNoteAt: null,
    noteCount: 0,
    latestCommitAt: null,
    ...overrides,
  };
}

/**
 * 探索メモとレビューログを持つ本文を組み立てる。
 *
 * `gate` は string で受ける。廃止された `explore` を書いたエントリが
 * 無視されることまで確かめたいため、規定のゲートに型で縛らない。
 */
function makeBody(options: {
  exploreNote?: boolean;
  entries?: ReadonlyArray<{ at: string; gate: string; kind: string }>;
}): string {
  const parts: string[] = ['## アイデア', '', 'なにかする。', ''];

  if (options.exploreNote === true) {
    parts.push('## 探索メモ', '', '- 調べた', '');
  }

  const entries = options.entries ?? [];
  if (entries.length > 0) {
    parts.push('## レビュー', '');
    for (const entry of entries) {
      parts.push(`### ${entry.at} ${entry.gate} ${entry.kind}`, '');
    }
  }

  return parts.join('\n');
}

const T1 = '2026-09-05T00:00:00.000Z';
const T2 = '2026-09-06T00:00:00.000Z';
const T3 = '2026-09-07T00:00:00.000Z';

/** plan を承認済みにした本文 */
function planApproved(): string {
  return makeBody({ entries: [{ at: T3, gate: 'plan', kind: '承認' }] });
}

// ============================================================
// 6 ステージの導出
// ============================================================

describe('resolveStage — 自動導出', () => {
  const cases: ReadonlyArray<{
    name: string;
    card: Card;
    plan: PlanDoc | null;
    mr: MrState | null;
    expected: Stage;
  }> = [
    {
      name: '何も無ければ idea',
      card: makeCard(),
      plan: null,
      mr: null,
      expected: 'idea',
    },
    {
      name: 'startedAt が打たれていれば planning',
      card: makeCard({ startedAt: T1 }),
      plan: null,
      mr: null,
      expected: 'planning',
    },
    {
      name: '探索メモがあってもステージは動かない',
      card: makeCard({ startedAt: T1, body: makeBody({ exploreNote: true }) }),
      plan: null,
      mr: null,
      expected: 'planning',
    },
    {
      name: '廃止された explore のエントリが残っていてもステージは動かない',
      card: makeCard({
        startedAt: T1,
        body: makeBody({
          exploreNote: true,
          entries: [
            { at: T2, gate: 'explore', kind: '提出' },
            { at: T3, gate: 'explore', kind: '否決' },
          ],
        }),
      }),
      plan: null,
      mr: null,
      expected: 'planning',
    },
    {
      name: 'startedAt が無ければ探索メモがあっても idea',
      card: makeCard({ body: makeBody({ exploreNote: true }) }),
      plan: null,
      mr: null,
      expected: 'idea',
    },
    {
      name: '計画ファイルがあれば plan-review',
      card: makeCard({ startedAt: T1 }),
      plan: makePlan(),
      mr: null,
      expected: 'plan-review',
    },
    {
      name: '計画ファイルがあり plan のログが無くても plan-review に着地する',
      card: makeCard({ startedAt: T1, body: makeBody({ exploreNote: true }) }),
      plan: makePlan(),
      mr: null,
      expected: 'plan-review',
    },
    {
      name: 'plan が否決されたら planning へ戻る',
      card: makeCard({
        startedAt: T1,
        body: makeBody({ entries: [{ at: T3, gate: 'plan', kind: '否決' }] }),
      }),
      plan: makePlan(),
      mr: null,
      expected: 'planning',
    },
    {
      name: 'plan が承認され tasks に未完があれば impling',
      card: makeCard({ startedAt: T1, body: planApproved() }),
      plan: makePlan({ tasks: { completed: 3, total: 10 } }),
      mr: null,
      expected: 'impling',
    },
    {
      // 検証中の列は廃止した。AI レビューは実装中の内部工程であり、
      // tasks の進捗はプログレスバーに出るだけでステージを立てない。
      name: 'plan が承認されていれば tasks を全部倒しても impling のまま',
      card: makeCard({ startedAt: T1, body: planApproved() }),
      plan: makePlan({ tasks: { completed: 10, total: 10 } }),
      mr: null,
      expected: 'impling',
    },
    {
      name: 'tasks が 0 件でも impling',
      card: makeCard({ startedAt: T1, skipGates: ['plan'] }),
      plan: makePlan({ tasks: { completed: 0, total: 0 } }),
      mr: null,
      expected: 'impling',
    },
    {
      name: 'MR が opened なら pr',
      card: makeCard({ startedAt: T1 }),
      plan: null,
      mr: makeMr({ state: 'opened' }),
      expected: 'pr',
    },
    {
      name: 'MR が merged なら merged',
      card: makeCard({ startedAt: T1 }),
      plan: null,
      mr: makeMr({ state: 'merged' }),
      expected: 'merged',
    },
    {
      name: '計画が archive されていれば merged',
      card: makeCard({ startedAt: T1 }),
      plan: makePlan({ archived: true }),
      mr: null,
      expected: 'merged',
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(resolveStage(testCase.card, testCase.plan, testCase.mr).stage).toBe(testCase.expected);
    });
  }

  it('複数の条件が成り立つときは最も進んだステージを採る', () => {
    const card = makeCard({ startedAt: T1, body: planApproved() });

    expect(resolveStage(card, makePlan(), makeMr()).stage).toBe('pr');
  });

  it('同じ実態からは同じステージが出る', () => {
    const card = makeCard({ startedAt: T1, body: planApproved() });
    const plan = makePlan();

    expect(resolveStage(card, plan, null)).toEqual(resolveStage(card, plan, null));
  });
});

// ============================================================
// 中止 と ゲートの状態
// ============================================================

describe('resolveStage — 中止', () => {
  it('最新のエントリが 中止 なら aborted', () => {
    const card = makeCard({
      startedAt: T1,
      body: makeBody({
        entries: [
          { at: T2, gate: 'plan', kind: '承認' },
          { at: T3, gate: 'plan', kind: '中止' },
        ],
      }),
    });

    expect(resolveStage(card, null, null).aborted).toBe(true);
  });

  it('中止のあとに再提出があれば aborted ではない', () => {
    const card = makeCard({
      startedAt: T1,
      body: makeBody({
        entries: [
          { at: T2, gate: 'plan', kind: '中止' },
          { at: T3, gate: 'plan', kind: '再提出' },
        ],
      }),
    });

    expect(resolveStage(card, null, null).aborted).toBe(false);
  });

  it('中止してもステージは巻き戻らない', () => {
    const card = makeCard({
      startedAt: T1,
      body: makeBody({
        entries: [
          { at: T2, gate: 'plan', kind: '承認' },
          { at: T3, gate: 'plan', kind: '中止' },
        ],
      }),
    });

    const resolution = resolveStage(card, null, null);

    expect(resolution.stage).toBe('impling');
    expect(resolution.aborted).toBe(true);
  });

  it('中止でなければ aborted は false', () => {
    expect(resolveStage(makeCard(), null, null).aborted).toBe(false);
  });
});

describe('resolveStage — ゲートの状態', () => {
  it('gates は plan の状態だけを載せる', () => {
    const card = makeCard({
      startedAt: T1,
      body: makeBody({ entries: [{ at: T2, gate: 'plan', kind: '否決' }] }),
    });

    expect(resolveStage(card, null, null).gates).toEqual({ plan: 'rejected' });
  });

  it('廃止された explore のエントリは plan の判定に混ざらない', () => {
    const card = makeCard({
      startedAt: T1,
      body: makeBody({ entries: [{ at: T2, gate: 'explore', kind: '承認' }] }),
    });

    expect(resolveStage(card, null, null).gates).toEqual({ plan: 'none' });
  });

  it('スキップを宣言したカードはレビュー列に留まらない', () => {
    const card = makeCard({ startedAt: T1, skipGates: ['plan'] });

    const stage = resolveStage(card, makePlan(), null).stage;

    expect(stage).not.toBe('plan-review');
  });
});

// ============================================================
// 人が動かせる範囲
// ============================================================

describe('resolveFloorStage / droppableStages', () => {
  it('人の列は idea と planning の 2 つだけ', () => {
    expect(HUMAN_STAGES).toEqual(['idea', 'planning']);
  });

  it('何も成果物が無いカードは idea と planning の間を動かせる', () => {
    const card = makeCard({ startedAt: T1 });
    const floor = resolveFloorStage(card, null, null);

    expect(floor).toBe('idea');
    expect(droppableStages(floor)).toEqual(['idea', 'planning']);
  });

  it('探索メモが書かれていても手で動かせる範囲は変わらない', () => {
    const card = makeCard({ startedAt: T1, body: makeBody({ exploreNote: true }) });
    const floor = resolveFloorStage(card, null, null);

    expect(floor).toBe('idea');
    expect(droppableStages(floor)).toEqual(['idea', 'planning']);
  });

  it('proposal が出ていれば手では動かせない', () => {
    const card = makeCard({ startedAt: T1 });
    const floor = resolveFloorStage(card, makePlan(), null);

    expect(floor).toBe('plan-review');
    expect(droppableStages(floor)).toEqual([]);
  });

  it('MR があれば手では動かせない', () => {
    const card = makeCard({ startedAt: T1 });
    const floor = resolveFloorStage(card, null, makeMr({ state: 'opened' }));

    expect(floor).toBe('pr');
    expect(droppableStages(floor)).toEqual([]);
  });
});

// ============================================================
// レビュー後の修正
// ============================================================

describe('hasFixAfterReview', () => {
  it('レビューコメントより後にコミットがあれば true', () => {
    expect(hasFixAfterReview(makeMr({ latestNoteAt: T1, latestCommitAt: T2 }))).toBe(true);
  });

  it('コメントのほうが新しければ false', () => {
    expect(hasFixAfterReview(makeMr({ latestNoteAt: T2, latestCommitAt: T1 }))).toBe(false);
  });

  it('コメントが 1 件も無ければ false', () => {
    expect(hasFixAfterReview(makeMr({ latestNoteAt: null, latestCommitAt: T2 }))).toBe(false);
  });

  it('再レビュー待ちでもステージは pr のまま', () => {
    const card = makeCard({ startedAt: T1 });
    const mr = makeMr({ state: 'opened', latestNoteAt: T1, latestCommitAt: T2, noteCount: 1 });

    const resolution = resolveStage(card, null, mr);

    expect(resolution.stage).toBe('pr');
    expect(resolution.reason).toContain('再レビュー待ち');
  });
});
