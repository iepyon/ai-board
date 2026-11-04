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
    draft: false,
    sourceBranch: 'feat/refresh-token',
    title: 'リフレッシュトークン対応',
    webUrl: 'https://github.com/acme/board/pull/42',
    latestNoteAt: null,
    noteCount: 0,
    latestCommitAt: null,
    mergedAt: null,
    readyAt: null,
    convertedToDraftAt: null,
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

const T4 = '2026-09-08T00:00:00.000Z';

/** plan を承認済みにした本文 */
function planApproved(): string {
  return makeBody({ entries: [{ at: T3, gate: 'plan', kind: '承認' }] });
}

/** plan を承認したあと、廃止した verify ゲートに `kinds` のエントリを順に書いた本文（過去のカードの形） */
function verifyAfterPlanApproved(...kinds: string[]): string {
  return makeBody({
    entries: [
      { at: T2, gate: 'plan', kind: '承認' },
      ...kinds.map((kind, index) => ({
        at: new Date(Date.parse(T3) + index * 1000).toISOString(),
        gate: 'verify',
        kind,
      })),
    ],
  });
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
      card: makeCard({
        startedAt: T1,
        skipGates: ['plan'],
        body: makeBody({ entries: [{ at: T2, gate: 'plan', kind: '提出' }] }),
      }),
      plan: makePlan({ tasks: { completed: 0, total: 0 } }),
      mr: null,
      expected: 'impling',
    },
    {
      name: 'PR が opened なら pr',
      card: makeCard({ startedAt: T1 }),
      plan: null,
      mr: makeMr({ state: 'opened' }),
      expected: 'pr',
    },
    {
      name: '計画ファイルが見えなくても Draft の PR があれば plan-review',
      card: makeCard({ startedAt: T1 }),
      plan: null,
      mr: makeMr({ draft: true }),
      expected: 'plan-review',
    },
    {
      name: 'Draft の PR で plan が提出されていれば plan-review',
      card: makeCard({
        startedAt: T1,
        body: makeBody({ entries: [{ at: T2, gate: 'plan', kind: '提出' }] }),
      }),
      plan: null,
      mr: makeMr({ draft: true }),
      expected: 'plan-review',
    },
    {
      name: 'Draft の PR で plan が否決されたら planning へ戻る',
      card: makeCard({
        startedAt: T1,
        body: makeBody({ entries: [{ at: T3, gate: 'plan', kind: '否決' }] }),
      }),
      plan: null,
      mr: makeMr({ draft: true }),
      expected: 'planning',
    },
    {
      name: 'Draft の PR で plan が承認されていれば impling',
      card: makeCard({ startedAt: T1, body: planApproved() }),
      plan: null,
      mr: makeMr({ draft: true }),
      expected: 'impling',
    },
    {
      // 廃止した verify ゲートのエントリは読み飛ばす。動作確認の列はもう無い
      name: '廃止した verify の提出が残っていても impling',
      card: makeCard({ startedAt: T1, body: verifyAfterPlanApproved('提出') }),
      plan: makePlan(),
      mr: makeMr({ draft: true }),
      expected: 'impling',
    },
    {
      name: '廃止した verify の承認が残っていて PR が Ready なら pr',
      card: makeCard({ startedAt: T1, body: verifyAfterPlanApproved('提出', '承認') }),
      plan: makePlan(),
      mr: makeMr({ draft: false }),
      expected: 'pr',
    },
    {
      name: 'plan が否決されていれば、廃止した verify の提出が後ろにあっても planning',
      card: makeCard({
        startedAt: T1,
        body: makeBody({
          entries: [
            { at: T2, gate: 'plan', kind: '否決' },
            { at: T3, gate: 'verify', kind: '提出' },
          ],
        }),
      }),
      plan: null,
      mr: makeMr({ draft: true }),
      expected: 'planning',
    },
    {
      name: 'Draft でも マージされていれば merged',
      card: makeCard({ startedAt: T1 }),
      plan: null,
      mr: makeMr({ state: 'merged', draft: true }),
      expected: 'merged',
    },
    {
      name: 'Draft の PR が閉じられていれば計画の成果物として数えない',
      card: makeCard({ startedAt: T1 }),
      plan: null,
      mr: makeMr({ state: 'closed', draft: true }),
      expected: 'planning',
    },
    {
      name: 'PR が merged なら merged',
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
  it('gates は plan の状態を載せる', () => {
    const card = makeCard({
      startedAt: T1,
      body: makeBody({ entries: [{ at: T2, gate: 'plan', kind: '否決' }] }),
    });

    expect(resolveStage(card, null, null).gates).toEqual({ plan: 'rejected' });
  });

  it('廃止された verify のエントリはゲートに現れない', () => {
    const card = makeCard({ startedAt: T1, body: verifyAfterPlanApproved('提出', '否決', '保留') });

    const resolved = resolveStage(card, makePlan(), makeMr({ draft: true }));

    expect(resolved.gates).toEqual({ plan: 'approved' });
    expect(resolved.stage).toBe('impling');
  });

  it('廃止された explore のエントリは plan の判定に混ざらない', () => {
    const card = makeCard({
      startedAt: T1,
      body: makeBody({ entries: [{ at: T2, gate: 'explore', kind: '承認' }] }),
    });

    expect(resolveStage(card, null, null).gates).toEqual({ plan: 'none' });
  });

  it('plan が held なら、計画ファイルと Draft の PR があっても 計画提案中 に留まる', () => {
    const card = makeCard({
      startedAt: T1,
      body: makeBody({
        entries: [
          { at: T2, gate: 'plan', kind: '提出' },
          { at: T3, gate: 'plan', kind: '否決' },
          { at: T4, gate: 'plan', kind: '保留' },
        ],
      }),
    });

    const resolved = resolveStage(card, makePlan(), makeMr({ draft: true }));

    expect(resolved.gates).toEqual({ plan: 'held' });
    expect(resolved.stage).toBe('planning');
  });

  it('計画から立て直させる: 承認済みの計画への否決で planning に落ち、承認し直すと impling', () => {
    const at = (minutes: number): string =>
      new Date(Date.parse(T2) + minutes * 60_000).toISOString();
    const log = [
      { at: at(0), gate: 'plan', kind: '承認' },
      { at: at(3), gate: 'plan', kind: '否決' },
      { at: at(4), gate: 'plan', kind: '再提出' },
      { at: at(5), gate: 'plan', kind: '承認' },
    ];
    const resolveAfter = (count: number) =>
      resolveStage(
        makeCard({ startedAt: T1, body: makeBody({ entries: log.slice(0, count) }) }),
        makePlan(),
        makeMr({ draft: true })
      );

    expect(resolveAfter(1).stage).toBe('impling');
    expect(resolveAfter(2).stage).toBe('planning');
    expect(resolveAfter(3).stage).toBe('plan-review');
    expect(resolveAfter(4).stage).toBe('impling');
  });
});

describe('resolveStage — 計画レビューを飛ばす宣言', () => {
  const submitted = makeBody({ entries: [{ at: T2, gate: 'plan', kind: '提出' }] });

  it('着手していなければ、エントリが無いうちは idea に留まる', () => {
    const card = makeCard({ skipGates: ['plan'] });

    expect(resolveStage(card, null, null).stage).toBe('idea');
  });

  it('着手して、エントリが無ければ planning', () => {
    const card = makeCard({ startedAt: T1, skipGates: ['plan'] });

    const resolved = resolveStage(card, null, null);

    expect(resolved.stage).toBe('planning');
    expect(resolved.gates).toEqual({ plan: 'none' });
  });

  it('plan 提出 があれば、計画ファイルと Draft の PR があっても計画レビューに留まらず impling', () => {
    const card = makeCard({ startedAt: T1, skipGates: ['plan'], body: submitted });

    const resolved = resolveStage(card, makePlan(), makeMr({ draft: true }));

    expect(resolved.stage).toBe('impling');
    expect(resolved.gates.plan).toBe('approved');
  });

  it('plan 否決 があれば planning へ戻る', () => {
    const card = makeCard({
      startedAt: T1,
      skipGates: ['plan'],
      body: makeBody({
        entries: [
          { at: T2, gate: 'plan', kind: '提出' },
          { at: T3, gate: 'plan', kind: '否決' },
        ],
      }),
    });

    expect(resolveStage(card, makePlan(), makeMr({ draft: true })).stage).toBe('planning');
  });

  it('未着手の下限は、提出の前は idea、提出の後は impling', () => {
    const before = makeCard({ startedAt: T1, skipGates: ['plan'] });
    const after = makeCard({ startedAt: T1, skipGates: ['plan'], body: submitted });

    expect(resolveFloorStage(before, null, null)).toBe('idea');
    expect(droppableStages(resolveFloorStage(before, null, null))).toEqual(['idea', 'planning']);
    expect(resolveFloorStage(after, makePlan(), makeMr({ draft: true }))).toBe('impling');
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

  it('Ready の PR があれば手では動かせない', () => {
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
    expect(resolution.reason).toBe('PR #42 にレビュー後の修正コミットあり（再レビュー待ち）');
  });
});

describe('resolveStage — 理由の文言', () => {
  // GitHub の PR は #n で書く。GitLab の MR の書き方（!n）を残さない
  it('Ready の PR は PR #n がオープン', () => {
    const resolution = resolveStage(makeCard({ startedAt: T1 }), null, makeMr());

    expect(resolution.reason).toBe('PR #42 がオープン');
  });

  it('マージ済みの PR は PR #n がマージ済み', () => {
    const resolution = resolveStage(makeCard(), null, makeMr({ state: 'merged', mergedAt: T2 }));

    expect(resolution.reason).toBe('PR #42 がマージ済み');
  });

  it('Draft の PR は 計画の PR #n', () => {
    const resolution = resolveStage(makeCard({ startedAt: T1 }), null, makeMr({ draft: true }));

    expect(resolution.reason).toBe('計画の PR #42（Draft）が人の承認を待っている');
  });
});
