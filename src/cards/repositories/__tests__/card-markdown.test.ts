import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { parseCard, serializeCard } from '../card-markdown.js';
import type { Card } from '../../models/card.js';
import type { CardId, MergeRequestIid } from '../../../shared/schemas/common.js';

beforeEach(() => {
  // 壊れたファイルの警告でテスト出力を汚さない
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'refresh-token' as CardId,
    title: 'リフレッシュトークン対応',
    created: '2026-09-01T00:00:00.000Z',
    startedAt: null,
    skipGates: [],
    branch: null,
    mr: null,
    rank: null,
    body: '',
    ...overrides,
  };
}

// ============================================================
// パースとシリアライズ
// ============================================================

describe('parseCard', () => {
  it('frontmatter と本文を読み分ける', () => {
    const raw = [
      '---',
      'id: refresh-token',
      'title: リフレッシュトークン対応',
      'created: 2026-09-01T00:00:00.000Z',
      'startedAt: 2026-09-05T00:00:00.000Z',
      'skipGates: [plan]',
      'change: refresh-token',
      'mr: 42',
      '---',
      '',
      '## アイデア',
      '本文',
    ].join('\n');

    const card = parseCard('/tmp/refresh-token.md', raw);

    expect(card).not.toBeNull();
    expect(card?.startedAt).toBe('2026-09-05T00:00:00.000Z');
    expect(card?.skipGates).toEqual(['plan']);
    expect(card?.mr).toBe(42);
    expect(card?.body).toBe('## アイデア\n本文');
  });

  it('廃止した change 行が残っていてもカードを読める', () => {
    // 計画ファイルへ移行する前のカードがそのまま残っていても壊れない。
    // 規定外のキーは Zod が黙って落とし、次の書き込みで消える。
    const raw = [
      '---',
      'id: legacy',
      'title: 旧カード',
      'created: 2026-09-01T00:00:00.000Z',
      'change: some-change',
      '---',
      '',
      '## アイデア',
    ].join('\n');

    const card = parseCard('/tmp/legacy.md', raw);

    expect(card?.id).toBe('legacy');
    expect(card).not.toHaveProperty('change');
  });

  it('YAML が Date に変換した日時を ISO 文字列へ戻す', () => {
    const raw = [
      '---',
      'id: dated',
      'title: 日時',
      'created: 2026-09-01T00:00:00Z',
      '---',
      '',
    ].join('\n');

    expect(parseCard('/tmp/dated.md', raw)?.created).toBe('2026-09-01T00:00:00.000Z');
  });

  it('未設定のフィールドは既定値で埋める', () => {
    const raw = ['---', 'id: minimal', 'title: 最小', '---', '', '本文'].join('\n');

    const card = parseCard('/tmp/minimal.md', raw);

    expect(card?.startedAt).toBeNull();
    expect(card?.skipGates).toEqual([]);
  });

  it('frontmatter が無くてもファイル名から id を補って読める', () => {
    const card = parseCard('/tmp/handwritten.md', 'ただのメモ');

    expect(card?.id).toBe('handwritten');
    expect(card?.title).toBe('handwritten');
    expect(card?.body).toBe('ただのメモ');
  });

  it('id とファイル名が食い違うカードは読み込まない', () => {
    const raw = ['---', 'id: other-id', 'title: ずれ', '---', ''].join('\n');

    expect(parseCard('/tmp/refresh-token.md', raw)).toBeNull();
  });

  it('不正なゲート名のカードは読み込まない', () => {
    const raw = ['---', 'id: bad', 'title: 不正', 'skipGates: [nonsense]', '---', ''].join('\n');

    expect(parseCard('/tmp/bad.md', raw)).toBeNull();
  });

  it('廃止された explore を skipGates に宣言したカードは読み込まない', () => {
    const raw = ['---', 'id: bad', 'title: 廃止ゲート', 'skipGates: [explore]', '---', ''].join(
      '\n'
    );

    expect(parseCard('/tmp/bad.md', raw)).toBeNull();
  });
});

describe('serializeCard', () => {
  it('skipGates を配列として往復できる', () => {
    const card = makeCard({
      startedAt: '2026-09-11T01:00:00.000Z',
      skipGates: ['plan'],
    });

    const restored = parseCard('/tmp/refresh-token.md', serializeCard(card));

    expect(restored?.skipGates).toEqual(['plan']);
    expect(restored?.startedAt).toBe('2026-09-11T01:00:00.000Z');
  });

  it('往復しても値が変わらない', () => {
    const card = makeCard({
      startedAt: '2026-09-04T10:12:00.000Z',
      skipGates: ['plan'],
      branch: 'feat/refresh-token',
      mr: 42 as MergeRequestIid,
      rank: 1500.5,
      body: '## アイデア\n本文',
    });

    const restored = parseCard('/tmp/refresh-token.md', serializeCard(card));

    expect(restored).toEqual(card);
  });

  it('GitLab の MR 番号は番号ごと捨てる', () => {
    const raw =
      '---\nid: refresh-token\ntitle: T\ncreated: 2026-09-01T00:00:00.000Z\nbranch: feat/x\nmr: 42\nforge: gitlab\n---\n';

    const card = parseCard('/tmp/refresh-token.md', raw);

    expect(card).toMatchObject({ branch: 'feat/x', mr: null });
  });

  it('GitHub の番号と取得先の記録が無い番号は残す', () => {
    const head =
      '---\nid: refresh-token\ntitle: T\ncreated: 2026-09-01T00:00:00.000Z\nbranch: feat/x\n';

    expect(parseCard('/tmp/refresh-token.md', `${head}mr: 42\n---\n`)?.mr).toBe(42);
    expect(parseCard('/tmp/refresh-token.md', `${head}mr: 42\nforge: github\n---\n`)?.mr).toBe(42);
  });

  it('null のフィールドを保ったまま書き出せる', () => {
    const restored = parseCard('/tmp/refresh-token.md', serializeCard(makeCard()));

    expect(restored?.mr).toBeNull();
    expect(restored?.startedAt).toBeNull();
    expect(restored?.skipGates).toEqual([]);
  });

  it('rank が null なら行を書かない', () => {
    // 並べ替えたことの無いカードを保存し直しても差分を生まないため
    const raw = serializeCard(makeCard());

    expect(raw).not.toContain('rank');
    expect(parseCard('/tmp/refresh-token.md', raw)?.rank).toBeNull();
  });
});
