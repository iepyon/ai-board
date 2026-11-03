import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DATA_VERSION,
  EMPTY_ORDER,
  assembleCard,
  compareLogNames,
  demoteHeadings,
  logFileName,
  parseDataVersion,
  parseLogFileName,
  parseOrder,
  planCardWrite,
  planReviewAppend,
  serializeCardFile,
  serializeDataVersion,
  serializeOrder,
  toLogStamp,
  withRank,
  type CardFiles,
  type LogFile,
  type LogName,
  type StoredCard,
} from '../card-files.js';
import type { Card } from '../../models/card.js';
import type { CardId, MergeRequestIid } from '../../../shared/schemas/common.js';
import { appendReviewEntry, gateState, parseReviewLog } from '../../services/review-log.js';
import type { ReviewEntry } from '../../models/review.js';

const ID = 'refresh-token' as CardId;

const NOW = '2026-11-01T10:00:00.000Z';

beforeEach(() => {
  // 読み飛ばしの警告でテスト出力を汚さない
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: ID,
    title: 'リフレッシュトークン対応',
    created: '2026-09-01T00:00:00.000Z',
    startedAt: null,
    skipGates: [],
    branch: null,
    mr: null,
    rank: null,
    body: '## アイデア\n\nトークンを更新する。',
    ...overrides,
  };
}

/** 新しいカードを書き、そのファイルを返す */
function create(card: Card): StoredCard {
  const write = planCardWrite(null, card, NOW);
  if (!write.ok) throw new Error(`作れませんでした: ${write.error.type}`);

  return {
    files: { cardMd: write.value.cardMd ?? '', log: write.value.logFiles },
    rank: card.rank,
  };
}

/** 今のファイルに `next` を書き、書いた後のファイルを返す */
function save(stored: StoredCard, next: Card, now = NOW): StoredCard {
  const write = planCardWrite(stored, next, now);
  if (!write.ok) throw new Error(`書けませんでした: ${write.error.type}`);

  return {
    files: {
      cardMd: write.value.cardMd ?? stored.files.cardMd,
      log: [...stored.files.log, ...write.value.logFiles],
    },
    rank: write.value.rankChanged ? next.rank : stored.rank,
  };
}

function read(stored: StoredCard): Card {
  const card = assembleCard(ID, stored.files, stored.rank);
  if (card === null) throw new Error('読めませんでした');
  return card;
}

function entry(overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return { at: '2026-11-01T04:00:00.000Z', gate: 'plan', kind: '提出', reason: '', ...overrides };
}

/** 判断を 1 件足し、足した後のファイルを返す（`appendReview` の口と同じ流れ） */
function append(stored: StoredCard, review: ReviewEntry): StoredCard {
  const result = planReviewAppend(ID, stored, review);
  if (!result.ok) throw new Error(`足せませんでした: ${result.error.type}`);

  return { ...stored, files: { ...stored.files, log: [...stored.files.log, result.value] } };
}

// ============================================================
// ai-board-data.yaml
// ============================================================

describe('parseDataVersion', () => {
  it('書いた版を読める', () => {
    expect(parseDataVersion(serializeDataVersion())).toEqual({ ok: true, value: DATA_VERSION });
  });

  it('新しい版は読まずに止まる', () => {
    expect(parseDataVersion(`version: ${DATA_VERSION + 1}\n`)).toEqual({
      ok: false,
      error: { type: 'UnsupportedDataVersion', found: DATA_VERSION + 1, supported: DATA_VERSION },
    });
  });

  it('version が無い・数でないものは壊れているとする', () => {
    expect(parseDataVersion('').ok).toBe(false);
    expect(parseDataVersion('version: one\n').ok).toBe(false);
    expect(parseDataVersion('version: [\n').ok).toBe(false);
  });
});

// ============================================================
// order.yaml
// ============================================================

describe('order.yaml', () => {
  it('ファイルが無い・空なら区切り線も rank も無い', () => {
    expect(parseOrder(null)).toEqual({ ok: true, value: EMPTY_ORDER });
    expect(parseOrder('\n')).toEqual({ ok: true, value: EMPTY_ORDER });
  });

  it('書いたものを読み戻せる。rank は ID の順に書く', () => {
    const order = { divider: 1500, ranks: { zeta: 3000, alpha: 1000 } };
    const raw = serializeOrder(order);

    expect(raw.indexOf('alpha')).toBeLessThan(raw.indexOf('zeta'));
    expect(parseOrder(raw)).toEqual({ ok: true, value: order });
  });

  it('withRank は null なら rank を消す', () => {
    const order = withRank({ divider: null, ranks: { a: 1 } }, 'b' as CardId, 2);

    expect(order.ranks).toEqual({ a: 1, b: 2 });
    expect(withRank(order, 'a' as CardId, null).ranks).toEqual({ b: 2 });
  });

  it('ID として不正なキーと数でない rank は読み飛ばす', () => {
    const result = parseOrder('divider: null\nranks:\n  ok-card: 10\n  Bad_Id: 20\n  other: x\n');

    expect(result).toEqual({ ok: true, value: { divider: null, ranks: { 'ok-card': 10 } } });
  });

  it('形が壊れていれば失敗にする（書き戻して全カードの rank を失わない）', () => {
    expect(parseOrder('divider: x\n').ok).toBe(false);
    expect(parseOrder('- a\n- b\n').ok).toBe(false);
  });
});

// ============================================================
// log/ のファイル名
// ============================================================

describe('判断のファイル名', () => {
  it('時刻はコロンを含まない形で、ミリ秒まで持つ', () => {
    expect(toLogStamp('2026-11-01T03:52:08.000Z')).toBe('20261101T035208.000Z');
    expect(toLogStamp('2026-11-01T12:52:08.5+09:00')).toBe('20261101T035208.500Z');
    expect(toLogStamp('not a date')).toBeNull();
  });

  it('種別は英字にし、読むと元の種別に戻る', () => {
    const name = logFileName('2026-11-01T03:52:08.000Z', 'verify', '否決', new Set());

    expect(name).toBe('20261101T035208.000Z.verify.reject.md');
    expect(parseLogFileName(name ?? '')).toEqual({
      at: '2026-11-01T03:52:08.000Z',
      gate: 'verify',
      kind: '否決',
      seq: 1,
    });
  });

  it('同じミリ秒に同じゲートと種別が重なったら -2、-3 を付ける', () => {
    const taken = new Set<string>();
    const names = [1, 2, 3].map((): string => {
      const name = logFileName('2026-11-01T03:52:08.000Z', 'plan', '提出', taken) ?? '';
      taken.add(name);
      return name;
    });

    expect(names).toEqual([
      '20261101T035208.000Z.plan.submit.md',
      '20261101T035208.000Z.plan.submit-2.md',
      '20261101T035208.000Z.plan.submit-3.md',
    ]);
  });

  it('連番は数として並べる（ファイル名の文字列の順では -2 が先に来る）', () => {
    const base = '20261101T035208.000Z.plan.submit';
    const names = [`${base}-10.md`, `${base}-2.md`, `${base}.md`]
      .map((name) => parseLogFileName(name))
      .filter((name): name is LogName => name !== null)
      .sort(compareLogNames);

    expect(names.map((name) => name.seq)).toEqual([1, 2, 10]);
  });

  it('規定外のゲートと種別の組み合わせ・ありえない時刻は読まない', () => {
    expect(parseLogFileName('20261101T035208.000Z.plan.start.md')).toBeNull();
    expect(parseLogFileName('20261101T035208.000Z.start.submit.md')).toBeNull();
    expect(parseLogFileName('20261101T035208.000Z.explore.submit.md')).toBeNull();
    expect(parseLogFileName('20261301T035208.000Z.plan.submit.md')).toBeNull();
    expect(parseLogFileName('20261101T035208.000Z.plan.submit-0.md')).toBeNull();
    expect(parseLogFileName('README.md')).toBeNull();
  });
});

// ============================================================
// 組み立て
// ============================================================

describe('assembleCard', () => {
  const cardMd = serializeCardFile(makeCard(), '## アイデア\n\nトークンを更新する。');

  function files(log: LogFile[]): CardFiles {
    return { cardMd, log };
  }

  it('card.md に startedAt・rank・## レビュー を書かない', () => {
    const stored = create(makeCard({ startedAt: '2026-09-05T00:00:00.000Z', rank: 1000 }));

    expect(stored.files.cardMd).not.toContain('startedAt');
    expect(stored.files.cardMd).not.toContain('rank');
    expect(stored.files.cardMd).not.toContain('## レビュー');
  });

  it('判断のファイルを時刻の順に ## レビュー の節にして、本文の最後に付ける', () => {
    const card = assembleCard(
      ID,
      files([
        { name: '20261101T050000.000Z.plan.reject.md', content: '見直して。\n' },
        { name: '20261101T040000.000Z.plan.submit.md', content: '' },
      ]),
      null
    );

    expect(card?.body).toBe(
      [
        '## アイデア',
        '',
        'トークンを更新する。',
        '',
        '## レビュー',
        '',
        '### 2026-11-01T04:00:00.000Z plan 提出',
        '',
        '### 2026-11-01T05:00:00.000Z plan 否決',
        '',
        '見直して。',
        '',
      ].join('\n')
    );
  });

  it('判断が無ければ ## レビュー の見出しを付けない', () => {
    expect(assembleCard(ID, files([]), null)?.body).toBe('## アイデア\n\nトークンを更新する。');
  });

  it('card.md の本文の ## レビュー の節は読まない', () => {
    const raw = serializeCardFile(
      makeCard(),
      '## アイデア\n\nA\n\n## レビュー\n\n### 2026-11-01T04:00:00.000Z plan 承認\n\n## 探索メモ\n\nB'
    );
    const card = assembleCard(ID, { cardMd: raw, log: [] }, null);

    expect(card?.body).toBe('## アイデア\n\nA\n\n## 探索メモ\n\nB');
    expect(parseReviewLog(card?.body ?? '')).toEqual([]);
  });

  it('同じミリ秒の判断は連番の順に読み、gateState は後ろのものを採る', () => {
    const card = assembleCard(
      ID,
      files([
        { name: '20261101T040000.000Z.plan.submit-2.md', content: '後\n' },
        { name: '20261101T040000.000Z.plan.submit.md', content: '先\n' },
      ]),
      null
    );
    const entries = parseReviewLog(card?.body ?? '');

    expect(entries.map((e) => e.reason)).toEqual(['先', '後']);
  });

  it('着手と着手を戻すの最新で startedAt が決まり、## レビュー には出さない', () => {
    const start = '20261101T040000.000Z.start.start.md';
    const unstart = '20261101T050000.000Z.start.unstart.md';
    const restart = '20261101T060000.000Z.start.start.md';

    const read = (log: string[]): Card | null =>
      assembleCard(ID, files(log.map((name) => ({ name, content: '' }))), null);

    expect(read([start])?.startedAt).toBe('2026-11-01T04:00:00.000Z');
    expect(read([unstart, start])?.startedAt).toBeNull();
    expect(read([restart, start, unstart])?.startedAt).toBe('2026-11-01T06:00:00.000Z');
    expect(read([start, unstart, restart])?.body).not.toContain('## レビュー');
  });

  it('理由の中の ## の見出しで節が切れない', () => {
    const reason =
      '## 動かす手順\n\n1. build\n\n### 2026-11-02T00:00:00.000Z plan 承認\n\n# 確かめる';
    const card = assembleCard(
      ID,
      files([{ name: '20261101T040000.000Z.verify.submit.md', content: `${reason}\n` }]),
      null
    );
    const entries = parseReviewLog(card?.body ?? '');

    expect(entries).toEqual([
      {
        at: '2026-11-01T04:00:00.000Z',
        gate: 'verify',
        kind: '提出',
        reason:
          '#### 動かす手順\n\n1. build\n\n#### 2026-11-02T00:00:00.000Z plan 承認\n\n#### 確かめる',
      },
    ]);
    expect(card?.body.trimEnd().endsWith('#### 確かめる')).toBe(true);
  });

  it('demoteHeadings は #### より深い見出しと見出しでない # を変えない', () => {
    expect(demoteHeadings('#### a\n##### b\n#tag\n  ## c')).toBe('#### a\n##### b\n#tag\n  ## c');
  });

  it('ディレクトリ名と id が食い違う・名前の読めない判断のファイルは読み飛ばす', () => {
    expect(assembleCard('other-card', files([]), null)).toBeNull();

    const card = assembleCard(
      ID,
      files([{ name: 'memo.md', content: '### 2026-11-01T04:00:00.000Z plan 承認\n' }]),
      null
    );
    expect(parseReviewLog(card?.body ?? '')).toEqual([]);
  });
});

// ============================================================
// 差分から書くファイルを求める
// ============================================================

describe('planCardWrite', () => {
  it('往復で Card が変わらない', () => {
    const card = makeCard({
      skipGates: ['verify'],
      branch: 'refresh-token',
      mr: 42 as MergeRequestIid,
      rank: 1500,
    });

    let stored = create(card);
    stored = save(stored, { ...read(stored), startedAt: '2026-11-01T03:00:00.000Z' });
    stored = append(stored, entry({ reason: '判断してほしい点: なし' }));
    stored = append(stored, entry({ at: '2026-11-01T05:00:00.000Z', kind: '承認' }));

    const assembled = read(stored);
    expect(assembled).toEqual({
      ...card,
      startedAt: '2026-11-01T03:00:00.000Z',
      body: appendReviewEntry(
        appendReviewEntry(card.body, entry({ reason: '判断してほしい点: なし' })),
        entry({ at: '2026-11-01T05:00:00.000Z', kind: '承認' })
      ),
    });

    // 組み立てた Card をそのまま保存し直しても、何も書かない
    expect(planCardWrite(stored, assembled, NOW)).toEqual({
      ok: true,
      value: { cardMd: null, logFiles: [], rankChanged: false },
    });
  });

  describe('## レビュー の書き換えを拒む', () => {
    const base = append(create(makeCard()), entry({ reason: '元の理由' }));
    const card = read(base);

    it.each([
      ['理由を変える', card.body.replace('元の理由', '書き換えた理由')],
      ['種別を変える', card.body.replace('plan 提出', 'plan 承認')],
      ['エントリを消す', '## アイデア\n\nトークンを更新する。\n\n## レビュー\n'],
      [
        '途中にエントリを足す',
        card.body.replace(
          '## レビュー\n',
          '## レビュー\n\n### 2026-10-01T00:00:00.000Z plan 承認\n'
        ),
      ],
      ['末尾に判断を足す', appendReviewEntry(card.body, entry({ kind: '承認' }))],
      [
        '末尾に判断を 2 件足す',
        appendReviewEntry(
          appendReviewEntry(card.body, entry({ reason: 'a' })),
          entry({ reason: 'b' })
        ),
      ],
    ])('%s', (_label, body) => {
      expect(planCardWrite(base, { ...card, body }, NOW)).toEqual({
        ok: false,
        error: { type: 'ReviewEntriesChanged', id: ID },
      });
    });

    it('判断の追記は本文の保存では受け付けず、log/ に何も足さない', () => {
      const stored = create(makeCard());
      const current = read(stored);

      // 判断の無いカードの末尾に、## レビュー の節ごと判断を足した本文
      expect(
        planCardWrite(
          stored,
          { ...current, body: appendReviewEntry(current.body, entry({ reason: '見て' })) },
          NOW
        )
      ).toEqual({ ok: false, error: { type: 'ReviewEntriesChanged', id: ID } });
    });

    it('新しいカードの本文に判断があれば拒む', () => {
      const body = appendReviewEntry('## アイデア', entry({ kind: '承認' }));

      expect(planCardWrite(null, makeCard({ body }), NOW)).toEqual({
        ok: false,
        error: { type: 'ReviewEntriesChanged', id: ID },
      });
    });
  });

  it('節の無い本文は判断を変えないと読み、判断を足さずに本文だけを書く', () => {
    const stored = append(
      append(create(makeCard()), entry({ reason: '見て' })),
      entry({ at: '2026-11-01T05:00:00.000Z', kind: '否決', reason: '直して' })
    );
    const card = read(stored);

    const planned = planCardWrite(
      stored,
      { ...card, body: '## アイデア\n\n期限前に更新する。' },
      NOW
    );
    expect(planned.ok && planned.value.logFiles).toEqual([]);
    expect(planned.ok && planned.value.cardMd).toContain('## アイデア\n\n期限前に更新する。');
    expect(planned.ok && planned.value.cardMd).not.toContain('## レビュー');

    const next = save(stored, { ...card, body: '## アイデア\n\n期限前に更新する。' });
    expect(next.files.log).toEqual(stored.files.log);
    expect(parseReviewLog(read(next).body)).toEqual(parseReviewLog(card.body));
    expect(read(next).body).toMatch(/^## アイデア\n\n期限前に更新する。\n\n## レビュー\n/);
  });

  it('新しいカードの節の無い本文はそのまま書く', () => {
    const planned = planCardWrite(null, makeCard({ body: '## アイデア\n\nメモ' }), NOW);

    expect(planned.ok && planned.value.logFiles).toEqual([]);
    expect(planned.ok && planned.value.cardMd).toContain('## アイデア\n\nメモ');
  });

  it('本文の差し替えは card.md に書き、判断を変えない限り ## レビュー の後ろの節も本文に移す', () => {
    const stored = append(create(makeCard()), entry());
    const card = read(stored);
    const body =
      card.body.replace('トークンを更新する。', '期限前に更新する。') + '\n## 探索メモ\n\nB';
    const next = save(stored, { ...card, body });

    expect(next.files.log).toEqual(stored.files.log);
    expect(read(next).body).toBe(
      appendReviewEntry('## アイデア\n\n期限前に更新する。\n\n## 探索メモ\n\nB', entry())
    );

    // 末尾に節を足しただけの本文も、判断の追記とは読まない
    const appended = save(stored, { ...card, body: `${card.body}\n## 探索メモ\n\nC` });
    expect(appended.files.log).toEqual(stored.files.log);
    expect(read(appended).body).toBe(
      appendReviewEntry('## アイデア\n\nトークンを更新する。\n\n## 探索メモ\n\nC', entry())
    );
  });

  it('frontmatter と rank の変更は card.md と rankChanged に出る', () => {
    const stored = create(makeCard());
    const card = read(stored);

    const branch = planCardWrite(stored, { ...card, branch: 'feature' }, NOW);
    expect(branch.ok && branch.value.cardMd).toContain('branch: feature');

    const rank = planCardWrite(stored, { ...card, rank: 500 }, NOW);
    expect(rank).toEqual({ ok: true, value: { cardMd: null, logFiles: [], rankChanged: true } });
  });

  describe('着手', () => {
    it('着手はその時刻の start、着手を戻すは now の unstart を足す', () => {
      let stored = create(makeCard());
      stored = save(stored, { ...read(stored), startedAt: '2026-11-01T03:00:00.000Z' });
      stored = save(stored, { ...read(stored), startedAt: null });

      expect(stored.files.log.map((file) => file.name)).toEqual([
        '20261101T030000.000Z.start.start.md',
        '20261101T100000.000Z.start.unstart.md',
      ]);
      expect(read(stored).startedAt).toBeNull();

      stored = save(stored, { ...read(stored), startedAt: '2026-11-01T11:00:00.000Z' });
      expect(read(stored).startedAt).toBe('2026-11-01T11:00:00.000Z');
    });

    it('着手の時刻より前の now で戻しても、着手を戻した側が最新になる', () => {
      let stored = create(makeCard({ startedAt: '2026-11-01T12:00:00.000Z' }));
      stored = save(stored, { ...read(stored), startedAt: null }, '2026-11-01T11:00:00.000Z');

      expect(read(stored).startedAt).toBeNull();
    });

    it('着手を戻したより前の時刻での着手は、最新にならないので拒む', () => {
      let stored = create(makeCard({ startedAt: '2026-11-01T03:00:00.000Z' }));
      stored = save(stored, { ...read(stored), startedAt: null });

      expect(
        planCardWrite(stored, { ...read(stored), startedAt: '2026-11-01T05:00:00.000Z' }, NOW)
      ).toEqual({
        ok: false,
        error: { type: 'StartedAtOutOfOrder', id: ID, startedAt: '2026-11-01T05:00:00.000Z' },
      });
    });
  });

  it('今の card.md が読めなければ書かない', () => {
    const stored: StoredCard = { files: { cardMd: '---\nid: [\n---\n', log: [] }, rank: null };

    expect(planCardWrite(stored, makeCard(), NOW)).toEqual({
      ok: false,
      error: { type: 'MalformedCardFile', id: ID },
    });
  });
});

describe('planReviewAppend', () => {
  it('判断を 1 件 1 ファイルにし、理由の前後の空白を落として中身にする', () => {
    const stored = create(makeCard());

    expect(planReviewAppend(ID, stored, entry({ reason: '\n  見て  \n' }))).toEqual({
      ok: true,
      value: { name: '20261101T040000.000Z.plan.submit.md', content: '見て\n' },
    });
    expect(planReviewAppend(ID, stored, entry({ gate: 'verify', kind: '否決' }))).toEqual({
      ok: true,
      value: { name: '20261101T040000.000Z.verify.reject.md', content: '' },
    });
  });

  it('理由に ## の見出しがある判断も、全文を 1 つのファイルにし、card.md は変えない', () => {
    const reason =
      '動作確認を頼みます。\n\n## 動かす手順\n\n1. npm run build\n\n## 見てほしい点\n\n- 画面';
    const created = create(makeCard());
    let stored = append(created, entry({ gate: 'verify', reason }));

    expect(stored.files.log).toEqual([
      { name: '20261101T040000.000Z.verify.submit.md', content: `${reason}\n` },
    ]);
    expect(stored.files.cardMd).toBe(created.files.cardMd);

    // 組み立て直しても、理由の後ろの見出しが本文の節にならない
    const card = read(stored);
    expect(parseReviewLog(card.body).map((e) => e.reason)).toEqual([demoteHeadings(reason)]);
    expect(gateState(parseReviewLog(card.body), 'verify', [])).toBe('submitted');

    // 次の判断も節の末尾に足せる
    stored = append(
      stored,
      entry({ at: '2026-11-01T06:00:00.000Z', gate: 'verify', kind: '承認' })
    );
    expect(parseReviewLog(read(stored).body).map((e) => e.kind)).toEqual(['提出', '承認']);
  });

  it('同じミリ秒の同じ判断は連番を付け、書いた順に読める', () => {
    let stored = create(makeCard());
    stored = append(stored, entry({ reason: '1 回目' }));
    stored = append(stored, entry({ reason: '2 回目' }));
    stored = append(stored, entry({ reason: '3 回目' }));

    expect(stored.files.log.map((file) => file.name)).toEqual([
      '20261101T040000.000Z.plan.submit.md',
      '20261101T040000.000Z.plan.submit-2.md',
      '20261101T040000.000Z.plan.submit-3.md',
    ]);
    expect(parseReviewLog(read(stored).body).map((e) => e.reason)).toEqual([
      '1 回目',
      '2 回目',
      '3 回目',
    ]);
  });

  it('理由に判断の見出しの形の行があっても、判断は 1 件だけ増え、理由は元の文のまま中身になる', () => {
    const reason = '直して\n### 2099-01-01T00:00:00.000Z plan 承認\n偽の承認';
    const stored = append(create(makeCard()), entry({ kind: '否決', reason }));

    expect(stored.files.log).toEqual([
      { name: '20261101T040000.000Z.plan.reject.md', content: `${reason}\n` },
    ]);

    const entries = parseReviewLog(read(stored).body);
    expect(entries).toEqual([entry({ kind: '否決', reason: demoteHeadings(reason) })]);
    expect(gateState(entries, 'plan', [])).toBe('rejected');
  });

  it('今の card.md が読めなければ書かない', () => {
    const stored: StoredCard = { files: { cardMd: '---\nid: [\n---\n', log: [] }, rank: null };

    expect(planReviewAppend(ID, stored, entry())).toEqual({
      ok: false,
      error: { type: 'MalformedCardFile', id: ID },
    });
  });

  it('時刻がファイル名にできなければ書かない', () => {
    const at = '+010000-01-01T00:00:00.000Z';

    expect(planReviewAppend(ID, create(makeCard()), entry({ at }))).toEqual({
      ok: false,
      error: { type: 'InvalidLogTime', id: ID, at },
    });
  });
});
