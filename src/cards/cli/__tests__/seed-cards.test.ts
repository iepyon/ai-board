import { describe, it, expect } from 'vitest';
import { readSeedCards, selectExportCards, toSeedFile, type SeedFile } from '../seed-cards.js';
import type { Card } from '../../models/card.js';
import type { CardId } from '../../../shared/schemas/common.js';

function file(name: string, frontmatter: string | null, body = '## アイデア\n題材'): SeedFile {
  const head = frontmatter === null ? '' : `---\n${frontmatter}\n---\n\n`;
  return { name, content: `${head}${body}\n` };
}

describe('readSeedCards', () => {
  it('ファイル名の順に読み、id・title・本文だけを返す', () => {
    const result = readSeedCards([
      file('b.md', 'title: B'),
      file('a.md', 'id: a\ntitle: A', '\n\n## アイデア\nA の本文\n\n'),
    ]);

    expect(result).toEqual({
      ok: true,
      value: [
        { file: 'a.md', id: 'a', title: 'A', body: '## アイデア\nA の本文' },
        { file: 'b.md', id: 'b', title: 'B', body: '## アイデア\n題材' },
      ],
    });
  });

  it('id を省けばファイル名から補う', () => {
    const result = readSeedCards([file('status-counts.md', 'title: 枚数')]);
    expect(result.ok && result.value[0]?.id).toBe('status-counts');
  });

  it('rank・startedAt・skipGates・branch・pr・created などは、不正な値でも読まない', () => {
    const result = readSeedCards([
      file(
        'a.md',
        'title: A\nrank: not-a-number\nstartedAt: いつか\nskipGates: [plan]\nbranch: x\npr: -1\ncreated: きのう\nextra: 1'
      ),
    ]);

    expect(result).toEqual({
      ok: true,
      value: [{ file: 'a.md', id: 'a', title: 'A', body: '## アイデア\n題材' }],
    });
  });

  it('読めないファイルを理由付きで全部返す', () => {
    const result = readSeedCards([
      file('ok.md', 'title: OK'),
      file('no-title.md', 'id: no-title'),
      file('empty-title.md', "title: ''"),
      file('mismatch.md', 'id: other\ntitle: X'),
      file('Bad_Name.md', 'title: X'),
      file('broken.md', 'title: [閉じない'),
      file('no-frontmatter.md', null),
    ]);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const reasons = Object.fromEntries(result.error.map((p) => [p.file, p.reason]));
    expect(Object.keys(reasons).sort()).toEqual([
      'Bad_Name.md',
      'broken.md',
      'empty-title.md',
      'mismatch.md',
      'no-frontmatter.md',
      'no-title.md',
    ]);
    expect(reasons['no-title.md']).toContain('title がありません');
    expect(reasons['empty-title.md']).toContain('title がありません');
    expect(reasons['no-frontmatter.md']).toContain('title がありません');
    expect(reasons['mismatch.md']).toBe(
      'frontmatter の id (other) がファイル名 (mismatch) と一致しません'
    );
    expect(reasons['Bad_Name.md']).toContain('ID が不正です: Bad_Name');
    expect(reasons['broken.md']).toContain('frontmatter を読めません');
  });

  it('ファイルが無ければ空で返す（*.md が無いことは呼び出し側が扱う）', () => {
    expect(readSeedCards([])).toEqual({ ok: true, value: [] });
  });
});

describe('selectExportCards と toSeedFile', () => {
  function card(id: string, overrides: Partial<Card> = {}): Card {
    return {
      id: id as CardId,
      title: `${id} の題`,
      created: '2026-09-01T00:00:00.000Z',
      startedAt: null,
      skipGates: [],
      branch: null,
      pr: null,
      rank: null,
      body: '## アイデア\n本文',
      ...overrides,
    } as Card;
  }

  const ABORTED =
    '## アイデア\nやめた\n\n## レビュー\n\n### 2026-09-20T00:00:00.000Z plan 中止\n\n要らない';

  it('中止のカードは外し、既定では着手していないカードだけを並びのまま選ぶ', () => {
    const cards = [
      card('b'),
      card('started', { startedAt: '2026-09-02T00:00:00.000Z' }),
      card('aborted', { body: ABORTED }),
      card('a'),
    ];

    expect(selectExportCards(cards, { includeStarted: false }).map((c) => c.id)).toEqual([
      'b',
      'a',
    ]);
    expect(selectExportCards(cards, { includeStarted: true }).map((c) => c.id)).toEqual([
      'b',
      'started',
      'a',
    ]);
  });

  it('書いたファイルは readSeedCards が id・title・判断を除いた本文で読み戻せる', () => {
    const source = card('refresh-token', {
      title: 'トークン: 更新 #1',
      startedAt: '2026-09-02T00:00:00.000Z',
      branch: 'feat/refresh-token',
      body: '## アイデア\n本文\n\n## レビュー\n\n### 2026-09-20T00:00:00.000Z plan 承認\n\nよい\n\n## 探索メモ\nメモ',
    });

    const file = toSeedFile(source);
    expect(file.name).toBe('refresh-token.md');
    expect(file.content).not.toContain('feat/refresh-token');

    expect(readSeedCards([file])).toEqual({
      ok: true,
      value: [
        {
          file: 'refresh-token.md',
          id: 'refresh-token',
          title: 'トークン: 更新 #1',
          body: '## アイデア\n本文\n\n## 探索メモ\nメモ',
        },
      ],
    });
  });

  it('本文が空のカードも読み戻せる', () => {
    expect(readSeedCards([toSeedFile(card('empty', { body: '' }))])).toEqual({
      ok: true,
      value: [{ file: 'empty.md', id: 'empty', title: 'empty の題', body: '' }],
    });
  });
});
