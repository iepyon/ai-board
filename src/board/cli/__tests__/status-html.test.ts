import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { Board, BoardCard, BoardCardMr } from '../../models/board-card.js';
import { buildStatusReport } from '../status-cli.js';
import {
  PR_LINK_ATTRIBUTES,
  REFRESH_MESSAGE,
  cardUrl,
  escapeHtml,
  formatStatusHtml,
  scriptJson,
} from '../status-html.js';
import type { BoardLoop } from '../../../shared/loop-activity.js';
import type { LoopStep } from '../../../shared/loop-step.js';

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
    gates: { plan: 'none' },
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
    reviews: [],
    loopSteps: [],
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

function html(
  cards: readonly BoardCard[],
  ideaDivider: number | null = null,
  loop: BoardLoop = { running: [], lastFinishedAt: null },
  session: string | null = null,
  repository: { readonly owner: string; readonly repo: string } | null = null
): string {
  const board: Board = {
    cards,
    forge: { status: 'connected', kind: 'github' },
    orphanPlans: [],
    ideaDivider,
    loop,
    generatedAt: '2026-10-23T00:00:00.000Z',
  };

  return formatStatusHtml(buildStatusReport(board, NOW), { session, repository });
}

/** タブの中身（`<div class="tab-panel" id="panel-<id>">` から次のタブの手前まで） */
function panel(page: string, id: string): string {
  const start = page.indexOf(`<div class="tab-panel" id="panel-${id}">`);
  if (start === -1) throw new Error(`タブがありません: ${id}`);

  const end = page.indexOf('<div class="tab-panel"', start + 1);

  return page.slice(start, end === -1 ? undefined : end);
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

describe('formatStatusHtml のループ', () => {
  const running: LoopStep = {
    loop: 'session-a',
    cardId: 'working',
    action: 'implement',
    step: 'task',
    agent: null,
    harness: null,
    startedAt: '2026-10-22T23:48:00.000Z',
    finishedAt: null,
    result: null,
    tokens: null,
    durationMs: null,
  };

  it('頭にループの様子を出し、今触っているカードに印を付ける', () => {
    const page = html(
      [card('working', { stage: 'impling' }), card('other', { stage: 'impling' })],
      null,
      { running: [running], lastFinishedAt: null }
    );

    expect(page).toContain(
      '<dt>ループ</dt><dd>working のタイトル を implement（task） 中（12 分）</dd>'
    );
    const work = section(page, 'AI 作業中');
    expect(work.indexOf('AI 稼働中')).toBeGreaterThan(work.indexOf('working のタイトル'));
    expect(work.indexOf('AI 稼働中')).toBeLessThan(work.indexOf('other のタイトル'));
    expect(work.match(/AI 稼働中/g)).toHaveLength(1);
  });

  it('記録が無ければ「記録なし」と出す', () => {
    expect(html([])).toContain('<dt>ループ</dt><dd>記録なし</dd>');
  });
});

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

  it('PR の URL を外側の窓で開くリンクにし、Draft なら添え、URL を文字でも出す', () => {
    const page = html([
      card('reviewing', { stage: 'plan-review', mr: 12, mrState: mrState({ draft: true }) }),
    ]);

    expect(PR_LINK_ATTRIBUTES).toBe('target="_top" rel="noreferrer"');
    expect(section(page, '判断待ち')).toContain(
      '<a href="https://github.com/o/r/pull/12" target="_top" rel="noreferrer">#12</a>（Draft） <span class="url">https://github.com/o/r/pull/12</span>'
    );
    expect(page).not.toContain('target="_blank"');
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
          gate: 'plan',
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

// ============================================================
// 集計
// ============================================================

describe('formatStatusHtml の集計', () => {
  const mergedCard = card('done', {
    stage: 'merged',
    startedAt: '2026-10-20T00:00:00.000Z',
    mrState: mrState({ state: 'merged', mergedAt: '2026-10-20T06:00:00.000Z' }),
    reviews: [{ at: '2026-10-20T01:00:00.000Z', gate: 'plan', kind: '否決', reason: '' }],
    timeline: [
      {
        kind: 'planning',
        owner: 'ai',
        start: '2026-10-20T00:00:00.000Z',
        end: '2026-10-20T01:00:00.000Z',
        phases: [],
      },
      {
        kind: 'plan-review',
        owner: 'human',
        start: '2026-10-20T01:00:00.000Z',
        end: '2026-10-20T06:00:00.000Z',
        phases: [],
      },
    ],
    loopSteps: [
      {
        loop: 'session-a',
        cardId: 'done',
        action: 'implement',
        step: 'task',
        agent: null,
        harness: null,
        startedAt: '2026-10-20T02:00:00.000Z',
        finishedAt: '2026-10-20T02:30:00.000Z',
        result: 'advanced',
        tokens: 12345,
        durationMs: 30 * 60 * 1000,
      },
    ],
  });

  it('振り返りのタブの頭に、主な数字・グラフ・ループの手の表を出す', () => {
    const page = html([mergedCard, card('idea')]);
    const metrics = page.slice(page.indexOf('<h2>集計</h2>'), page.indexOf('<h2>マージ済み '));

    expect(panel(page, 'retro')).toContain('<h2>集計</h2>');
    expect(page.indexOf('<h2>集計</h2>')).toBeLessThan(page.indexOf('<h2>マージ済み '));
    expect(metrics).toContain('<dt>マージ済み</dt><dd>1 枚</dd>');
    expect(metrics).toContain('<dt>着手からマージ（中央値）</dt><dd>6時間</dd>');
    expect(metrics).toContain('<dt>人の番の割合（中央値）</dt><dd>83%</dd>');
    expect(metrics).toContain('<dt>否決</dt><dd>1 枚・1 回</dd>');
    expect(metrics).toContain('<dt>アイデアの残り</dt><dd>1 枚</dd>');
    expect(metrics).toContain('ボトルネックは計画レビュー');
    expect(metrics).toContain('data-date="2026-10-20"');
    expect(metrics).toContain(
      '<th scope="row">implement · task</th><td>1</td><td>30分</td><td>12,345</td>'
    );
    expect(metrics).toContain('<li>進めた <span class="count">1</span></li>');
  });

  it('集計の元が無ければ、数字は — にし、グラフと表は「まだありません」', () => {
    const page = html([]);
    const metrics = page.slice(page.indexOf('<h2>集計</h2>'), page.indexOf('<h2>マージ済み '));

    expect(metrics).toContain('<dt>着手からマージ（中央値）</dt><dd>—</dd>');
    expect(metrics.match(/まだありません/g)?.length).toBe(4);
  });

  it('色のトークンを明るい / 暗いの両方に持つ', () => {
    const page = html([]);

    expect(page.match(/--chart-human:/g)?.length).toBe(3);
    expect(page.match(/--chart-ai:/g)?.length).toBe(3);
  });
});

// ============================================================
// タブ
// ============================================================

describe('formatStatusHtml のタブ', () => {
  it('今 / ログ / 振り返り の 3 つのタブを、スクリプト無しのラジオボタンで切り替える。最初は今', () => {
    const page = html([card('reviewing', { stage: 'plan-review' })]);

    expect(page).toContain(
      '<input type="radio" name="tab" class="tab-input" id="tab-now" checked>'
    );
    expect(page).toContain('<input type="radio" name="tab" class="tab-input" id="tab-log">');
    expect(page).toContain('<input type="radio" name="tab" class="tab-input" id="tab-retro">');
    expect(page).toContain(
      '<nav class="tab-list"><label for="tab-now">今 <span class="count">1</span></label><label for="tab-log">ログ</label><label for="tab-retro">振り返り</label></nav>'
    );
    expect(page).toContain('#tab-now:checked ~ #panel-now');
    expect(page).not.toMatch(/<script/i);
  });

  it('今に判断待ち・AI 作業中・アイデア、振り返りに集計・マージ済み・中止を入れる', () => {
    const page = html([
      card('reviewing', { stage: 'plan-review' }),
      card('working', { stage: 'impling' }),
      card('idea'),
      card('merged', { stage: 'merged' }),
      card('aborted', { stage: 'impling', aborted: true }),
    ]);
    const now = panel(page, 'now');
    const retro = panel(page, 'retro');

    for (const title of ['<h2>判断待ち ', '<h2>AI 作業中 ', '<h2>アイデア ']) {
      expect(now).toContain(title);
      expect(retro).not.toContain(title);
    }
    for (const title of ['<h2>集計</h2>', '<h2>マージ済み ', '<h2>中止 ']) {
      expect(retro).toContain(title);
      expect(now).not.toContain(title);
    }
    expect(panel(page, 'log')).toContain('<h2>ログ ');
  });

  it('AI 作業中のカードに、今の手を添える', () => {
    const running: LoopStep = {
      loop: 'session-a',
      cardId: 'working',
      action: 'implement',
      step: 'review',
      agent: null,
      harness: null,
      startedAt: '2026-10-22T23:48:00.000Z',
      finishedAt: null,
      result: null,
      tokens: null,
      durationMs: null,
    };
    const page = html([card('working', { stage: 'impling' })], null, {
      running: [running],
      lastFinishedAt: null,
    });

    expect(section(page, 'AI 作業中')).toContain(
      '<p class="running">AI 稼働中 · implement（review）</p>'
    );
  });
});

// ============================================================
// ログ
// ============================================================

describe('formatStatusHtml のログ', () => {
  it('ループの手と判断を、新しい順の 1 本にして出す（廃止した手の過去の記録も出す）', () => {
    const page = html([
      card('a', {
        stage: 'impling',
        reviews: [{ at: '2026-10-21T00:00:00.000Z', gate: 'plan', kind: '否決', reason: '直して' }],
        loopSteps: [
          {
            loop: 'session-a',
            cardId: 'a',
            action: 'revise-impl',
            step: null,
            agent: null,
            harness: null,
            startedAt: '2026-10-22T00:00:00.000Z',
            finishedAt: '2026-10-22T00:01:35.000Z',
            result: 'advanced',
            tokens: 81_000,
            durationMs: 95_000,
          },
        ],
      }),
    ]);
    const log = section(page, 'ログ');

    expect(log).toContain('<span class="count">2</span>');
    expect(log).toContain('revise-impl · 進めた · 1 分 35 秒 · 81k トークン');
    expect(log).toContain('<p>plan 否決</p>');
    expect(log).toContain('<summary>理由</summary><div class="review">直して</div>');
    expect(log.indexOf('revise-impl')).toBeLessThan(log.indexOf('plan 否決'));
    expect(log).toContain('2026-10-22 00:00 UTC');
  });

  it('記録が無ければ「ありません」', () => {
    expect(section(html([card('idea')]), 'ログ')).toContain('ありません');
  });

  it('判断の理由と、カードのタイトルをエスケープする', () => {
    const page = html([
      card('a', {
        title: '<b>x</b>',
        reviews: [
          { at: '2026-10-21T00:00:00.000Z', gate: 'plan', kind: '否決', reason: '<i>y</i>' },
        ],
      }),
    ]);
    const log = section(page, 'ログ');

    expect(log).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(log).toContain('&lt;i&gt;y&lt;/i&gt;');
    expect(log).not.toContain('<i>');
  });
});

// ============================================================
// カードの詳細へのリンク
// ============================================================

describe('formatStatusHtml のカードの詳細へのリンク', () => {
  const repository = { owner: 'o', repo: 'r' };

  it('cardUrl はデータ用ブランチのカードのファイルを指し、各部分をエスケープする', () => {
    expect(cardUrl(repository, 'my-card')).toBe(
      'https://github.com/o/r/blob/ai-board/data/cards/my-card/card.md'
    );
    expect(cardUrl({ owner: 'o"', repo: 'r?x' }, 'a b')).toBe(
      'https://github.com/o%22/r%3Fx/blob/ai-board/data/cards/a%20b/card.md'
    );
  });

  it('リポジトリがあれば、カード・アイデア・ログのタイトルを外側の窓で開くリンクにする', () => {
    const page = html(
      [
        card('reviewing', {
          stage: 'plan-review',
          reviews: [{ at: '2026-10-21T00:00:00.000Z', gate: 'plan', kind: '提出', reason: '' }],
        }),
        card('idea'),
      ],
      null,
      undefined,
      null,
      repository
    );
    const link = (id: string): string =>
      `<a href="https://github.com/o/r/blob/ai-board/data/cards/${id}/card.md" ${PR_LINK_ATTRIBUTES}>${id} のタイトル</a>`;

    expect(section(page, '判断待ち')).toContain(link('reviewing'));
    expect(section(page, 'アイデア')).toContain(link('idea'));
    expect(section(page, 'ログ')).toContain(link('reviewing'));
  });

  it('リポジトリが無ければ、リンクを付けない', () => {
    const page = html([card('idea')]);

    expect(page).not.toContain('/card.md');
    expect(section(page, 'アイデア')).toContain('<li>idea のタイトル <code>idea</code></li>');
  });
});

// ============================================================
// 更新ボタン
// ============================================================

describe('formatStatusHtml の更新ボタン', () => {
  it('session が無ければ、スクリプトもボタンも入れず、チャットで頼む案内を出す', () => {
    const page = html([]);

    expect(page).not.toMatch(/<script|<button/i);
    expect(page).toContain('チャットで「ボードを見せて」と頼んでください');
  });

  it('session があれば、隠した更新ボタンと、セッション ID を埋め込んだスクリプトを入れる', () => {
    const page = html([], null, undefined, 'session_01ABCDEF');

    expect(page).toContain('<button type="button" id="refresh-button" hidden>更新</button>');
    expect(page).toContain('チャットで「ボードを見せて」と頼んでください');
    expect(page.match(/<script>/g)?.length).toBe(1);
    expect(page).toContain('"session":"session_01ABCDEF"');
    expect(page).toContain('"server":"Claude Code Remote"');
    expect(page).toContain('"tool":"send_message"');
    expect(page).toContain(scriptJson(REFRESH_MESSAGE));
    expect(page).toContain("window.claude.use('mcp')");
    expect(page).toContain('session_id: config.session, message: config.message');
    expect(page).toContain('"timeoutMs":180000');
    // 外部のファイルは読まない
    expect(page).not.toMatch(/<link|src=/i);
  });

  it('送る文は board-dashboard のスキルが応える文と同じ', () => {
    const skill = readFileSync(
      new URL('../../../../.claude/skills/board-dashboard/SKILL.md', import.meta.url),
      'utf8'
    );

    expect(skill).toContain(`\n  ${REFRESH_MESSAGE}\n`);
  });

  it('埋め込む JSON の < は逃がし、</script> で抜けられない', () => {
    expect(scriptJson({ session: 'x</script><script>alert(1)</script>' })).toBe(
      '{"session":"x\\u003c/script>\\u003cscript>alert(1)\\u003c/script>"}'
    );

    const page = html([], null, undefined, 'session_01ABCDEF');
    const script = page.slice(
      page.indexOf('<script>') + '<script>'.length,
      page.indexOf('</script>')
    );
    expect(script).not.toContain('<');
  });
});
