import { describe, it, expect } from 'vitest';
import {
  HUMAN_STAGES,
  droppableStages,
  hasFixAfterReview,
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
    startedAt: null,
    skipGates: [],
    change: 'refresh-token' as ChangeName,
    branch: null,
    mr: null,
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
    forge: 'gitlab',
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

const PROPOSAL_ONLY = { proposal: true, specs: false, design: false, tasks: false };
const PROPOSAL_AND_TASKS = { proposal: true, specs: false, design: false, tasks: true };

/** plan を承認済みにした本文 */
function planApproved(): string {
  return makeBody({ entries: [{ at: T3, gate: 'plan', kind: '承認' }] });
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
      name: '何も無ければ idea',
      card: makeCard(),
      openspec: null,
      mr: null,
      expected: 'idea',
    },
    {
      name: 'startedAt が打たれていれば planning',
      card: makeCard({ startedAt: T1 }),
      openspec: null,
      mr: null,
      expected: 'planning',
    },
    {
      name: '探索メモがあってもステージは動かない',
      card: makeCard({ startedAt: T1, body: makeBody({ exploreNote: true }) }),
      openspec: null,
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
      openspec: null,
      mr: null,
      expected: 'planning',
    },
    {
      name: 'startedAt が無ければ探索メモがあっても idea',
      card: makeCard({ body: makeBody({ exploreNote: true }) }),
      openspec: null,
      mr: null,
      expected: 'idea',
    },
    {
      name: 'proposal.md があれば plan-review',
      card: makeCard({ startedAt: T1 }),
      openspec: makeOpenSpec({ artifacts: PROPOSAL_ONLY }),
      mr: null,
      expected: 'plan-review',
    },
    {
      name: 'proposal.md があり plan のログが無くても plan-review に着地する',
      card: makeCard({ startedAt: T1, body: makeBody({ exploreNote: true }) }),
      openspec: makeOpenSpec({ artifacts: PROPOSAL_ONLY }),
      mr: null,
      expected: 'plan-review',
    },
    {
      name: 'plan が否決されたら planning へ戻る',
      card: makeCard({
        startedAt: T1,
        body: makeBody({ entries: [{ at: T3, gate: 'plan', kind: '否決' }] }),
      }),
      openspec: makeOpenSpec({ artifacts: PROPOSAL_ONLY }),
      mr: null,
      expected: 'planning',
    },
    {
      name: 'plan が承認され tasks に未完があれば impling',
      card: makeCard({ startedAt: T1, body: planApproved() }),
      openspec: makeOpenSpec({
        artifacts: PROPOSAL_AND_TASKS,
        tasks: { completed: 3, total: 10 },
      }),
      mr: null,
      expected: 'impling',
    },
    {
      // 検証中の列は廃止した。AI レビューは実装中の内部工程であり、
      // tasks の進捗はプログレスバーに出るだけでステージを立てない。
      name: 'plan が承認されていれば tasks を全部倒しても impling のまま',
      card: makeCard({ startedAt: T1, body: planApproved() }),
      openspec: makeOpenSpec({
        artifacts: PROPOSAL_AND_TASKS,
        tasks: { completed: 10, total: 10 },
      }),
      mr: null,
      expected: 'impling',
    },
    {
      name: 'tasks が 0 件でも impling',
      card: makeCard({ startedAt: T1, skipGates: ['plan'] }),
      openspec: makeOpenSpec({ tasks: { completed: 0, total: 0 } }),
      mr: null,
      expected: 'impling',
    },
    {
      name: 'MR が opened なら pr',
      card: makeCard({ startedAt: T1 }),
      openspec: null,
      mr: makeMr({ state: 'opened' }),
      expected: 'pr',
    },
    {
      name: 'MR が merged なら merged',
      card: makeCard({ startedAt: T1 }),
      openspec: null,
      mr: makeMr({ state: 'merged' }),
      expected: 'merged',
    },
    {
      name: 'archive にあれば merged',
      card: makeCard({ startedAt: T1 }),
      openspec: makeOpenSpec({ archived: true, archivedAs: '2026-09-01-refresh-token' }),
      mr: null,
      expected: 'merged',
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(resolveStage(testCase.card, testCase.openspec, testCase.mr).stage).toBe(
        testCase.expected
      );
    });
  }

  it('複数の条件が成り立つときは最も進んだステージを採る', () => {
    const card = makeCard({ startedAt: T1, body: planApproved() });

    expect(resolveStage(card, makeOpenSpec({ artifacts: PROPOSAL_ONLY }), makeMr()).stage).toBe(
      'pr'
    );
  });

  it('同じ実態からは同じステージが出る', () => {
    const card = makeCard({ startedAt: T1, body: planApproved() });
    const openspec = makeOpenSpec({ artifacts: PROPOSAL_ONLY });

    expect(resolveStage(card, openspec, null)).toEqual(resolveStage(card, openspec, null));
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

    const stage = resolveStage(card, makeOpenSpec({ artifacts: PROPOSAL_ONLY }), null).stage;

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
    const floor = resolveFloorStage(card, makeOpenSpec({ artifacts: PROPOSAL_ONLY }), null);

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
