import { describe, it, expect } from 'vitest';
import type { Board, BoardCard, BoardCardMr } from '../../models/board-card.js';
import { buildStatusReport } from '../status-cli.js';
import { escapeHtml, formatStatusHtml } from '../status-html.js';

// ============================================================
// テスト用のボード
// ============================================================

const NOW = new Date('2026-10-23T00:00:00.000Z');

function card(id: string, overrides: Partial<BoardCard> = {}): BoardCard {
  return {
    id,
    title: `${id} のタイトル`,
    created: '2026-10-01T00:00:00.000Z',
    stage: 'idea',
    reason: `${id} の理由`,
    aborted: false,
    gates: { plan: 'none', verify: 'none' },
    latestReview: null,
    floorStage: 'idea',
    droppableStages: [],
    startedAt: null,
    skipGates: [],
    branch: null,
    mr: null,
    rank: null,
    body: '',
    plan: null,
    mrState: null,
    hold: null,
    timeline: [],
    ...overrides,
  };
}

function mrState(overrides: Partial<BoardCardMr> = {}): BoardCardMr {
  return {
    forge: 'github',
    iid: 12,
    state: 'opened',
    draft: false,
    title: 'PR',
    webUrl: 'https://github.com/o/r/pull/12',
    noteCount: 0,
    latestNoteAt: null,
    latestCommitAt: null,
    resubmitted: false,
    mergedAt: null,
    readyAt: null,
    convertedToDraftAt: null,
    ...overrides,
  };
}

function html(cards: readonly BoardCard[], ideaDivider: number | null = null): string {
  const board: Board = {
    cards,
    forge: { status: 'connected', kind: 'github' },
    orphanPlans: [],
    ideaDivider,
    generatedAt: '2026-10-23T00:00:00.000Z',
  };

  return formatStatusHtml(buildStatusReport(board, NOW));
}

/** 見出し `<h2>` で区切った区画の HTML。区画にどのカードが出るかを確かめる */
function section(page: string, title: string): string {
  const start = page.indexOf(`<h2>${title} `);
  if (start === -1) throw new Error(`区画がありません: ${title}`);

  const end = page.indexOf('<h2>', start + 1);

  return page.slice(start, end === -1 ? undefined : end);
}

// ============================================================
// 形
// ============================================================

describe('formatStatusHtml', () => {
  it('スクリプトも外部のファイルも読まない、1 枚の HTML を出す', () => {
    const page = html([]);

    expect(page.startsWith('<!doctype html>')).toBe(true);
    expect(page).toContain('<meta charset="utf-8">');
    expect(page).toContain('<meta name="viewport"');
    expect(page).toContain('<title>ai-board ボード</title>');
    expect(page).not.toMatch(/<script|<link|<button|src=/i);
  });

  it('生成の時刻・GitHub の接続・次の一手を頭に出す', () => {
    const page = html([card('started', { stage: 'planning', startedAt: NOW.toISOString() })]);

    expect(page).toContain('2026-10-23 00:00 UTC');
    expect(page).toContain('接続済み');
    expect(page).toContain('plan started（');
  });

  it('判断待ち / AI 作業中 / アイデア / マージ済み / 中止 の区画に、画面と同じ振り分けで出す', () => {
    const page = html([
      card('reviewing', { stage: 'plan-review' }),
      card('working', { stage: 'impling' }),
      card('idea'),
      card('merged', { stage: 'merged' }),
      card('aborted', { stage: 'impling', aborted: true }),
    ]);

    expect(section(page, '判断待ち')).toContain('reviewing のタイトル');
    expect(section(page, 'AI 作業中')).toContain('working のタイトル');
    expect(section(page, 'アイデア')).toContain('idea のタイトル');
    expect(section(page, 'マージ済み')).toContain('merged のタイトル');
    expect(section(page, '中止')).toContain('aborted のタイトル');
    // 中止のカードは AI 作業中に出さない
    expect(section(page, 'AI 作業中')).not.toContain('aborted のタイトル');
  });

  it('カードの無い区画には「ありません」と出す', () => {
    const page = html([]);

    expect(section(page, '判断待ち')).toContain('ありません');
    expect(section(page, 'アイデア')).toContain('ありません');
  });
});

// ============================================================
// 判断待ち
// ============================================================

describe('formatStatusHtml の判断待ち', () => {
  it('提出の本文を改行を保って出し、判断のラベルを並べる（ボタンは置かない）', () => {
    const page = html([
      card('reviewing', {
        stage: 'plan-review',
        latestReview: {
          at: '2026-10-20T00:00:00.000Z',
          gate: 'plan',
          kind: '提出',
          reason: '判断してほしい点\n- 分け方',
        },
      }),
    ]);
    const waiting = section(page, '判断待ち');

    expect(waiting).toContain('plan 提出 · 2026-10-20 00:00 UTC');
    expect(waiting).toContain('判断してほしい点\n- 分け方');
    expect(waiting).toContain('承認 / 否決して差し戻す / 中止する');
    expect(waiting).not.toContain('<button');
  });

  it('PR の URL をリンクにし、Draft なら添える', () => {
    const page = html([
      card('reviewing', { stage: 'plan-review', mr: 12, mrState: mrState({ draft: true }) }),
    ]);

    expect(section(page, '判断待ち')).toContain(
      '<a href="https://github.com/o/r/pull/12" target="_blank" rel="noreferrer">#12</a>（Draft）'
    );
  });

  it('PR の状態が引けなければ、番号だけを文字で出す', () => {
    const page = html([card('pr', { stage: 'pr', mr: 7 })]);

    expect(section(page, '判断待ち')).toContain('<span class="label">PR</span>#7</p>');
  });

  it('止まっているカードは、ステージの理由の代わりに止まりの理由を出す', () => {
    const page = html([
      card('held', {
        stage: 'impling',
        hold: { reason: 'AI が保留した。判断してほしい', since: '2026-10-21T00:00:00.000Z' },
      }),
    ]);
    const waiting = section(page, '判断待ち');

    expect(waiting).toContain('止まり</span>AI が保留した。判断してほしい');
    expect(waiting).not.toContain('held の理由');
    expect(section(page, 'AI 作業中')).not.toContain('held のタイトル');
  });
});

// ============================================================
// ほかの区画
// ============================================================

describe('formatStatusHtml のほかの区画', () => {
  it('AI 作業中には、タスクの進み具合と動きの無いことを出す', () => {
    const page = html([
      card('working', {
        stage: 'impling',
        plan: {
          tasks: { completed: 3, total: 10 },
          archived: false,
          updatedAt: '2026-10-01T00:00:00.000Z',
        },
      }),
    ]);
    const working = section(page, 'AI 作業中');

    expect(working).toContain('タスク 3/10');
    expect(working).toContain('動きなし');
  });

  it('アイデアは区切り線を挟んで、画面と同じ順に並べる', () => {
    const page = html(
      [card('first', { rank: 1 }), card('later', { rank: 5 }), card('second', { rank: 2 })],
      3
    );
    const ideas = section(page, 'アイデア');

    const order = ['first', 'second', 'あとで考える', 'later'].map((text) => ideas.indexOf(text));
    expect(order.every((at) => at !== -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(ideas).toContain('<span class="count">3</span>');
  });

  it('マージ済みには、マージの時刻と PR を新しい順に出す', () => {
    const page = html([
      card('old', {
        stage: 'merged',
        mr: 1,
        mrState: mrState({ iid: 1, state: 'merged', mergedAt: '2026-10-01T00:00:00.000Z' }),
      }),
      card('new', {
        stage: 'merged',
        mr: 2,
        mrState: mrState({ iid: 2, state: 'merged', mergedAt: '2026-10-10T00:00:00.000Z' }),
      }),
    ]);
    const merged = section(page, 'マージ済み');

    expect(merged).toContain('2026-10-10 00:00 UTC');
    expect(merged.indexOf('new のタイトル')).toBeLessThan(merged.indexOf('old のタイトル'));
  });
});

// ============================================================
// 文字の扱い
// ============================================================

describe('formatStatusHtml の文字の扱い', () => {
  const ATTACK = '<script>alert("x")</script>\'&';

  it('タイトル・理由・止まりの理由・提出の本文・ID をエスケープする', () => {
    const page = html([
      card('held', {
        title: ATTACK,
        stage: 'impling',
        hold: { reason: ATTACK, since: '2026-10-21T00:00:00.000Z' },
        latestReview: {
          at: '2026-10-21T00:00:00.000Z',
          gate: 'verify',
          kind: '保留',
          reason: ATTACK,
        },
      }),
      card('idea', { title: ATTACK }),
      card('working', { stage: 'planning', reason: ATTACK }),
    ]);

    expect(page).not.toContain('<script>');
    expect(page).not.toContain('"x"');
    expect(page).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&#39;&amp;');
  });

  it('http(s) でない PR の URL はリンクにしない', () => {
    const page = html([
      card('reviewing', {
        stage: 'plan-review',
        mr: 3,
        mrState: mrState({ iid: 3, webUrl: 'javascript:alert(1)' }),
      }),
    ]);

    expect(page).not.toContain('javascript:');
    expect(section(page, '判断待ち')).toContain('<span class="label">PR</span>#3</p>');
  });

  it('escapeHtml は & < > " \' を置き換える', () => {
    expect(escapeHtml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&#39;f');
  });
});
