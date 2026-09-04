import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsCardRepository, parseCard, serializeCard } from '../fs-card.repository.js';
import type { Card } from '../../models/card.js';
import type { CardId, ChangeName, MergeRequestIid } from '../../../shared/schemas/common.js';

let cardsDir: string;

beforeEach(async () => {
  cardsDir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-cards-')), 'cards');
  // 壊れたファイルの警告でテスト出力を汚さない
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(path.dirname(cardsDir), { recursive: true, force: true });
});

async function writeCardFile(name: string, content: string): Promise<void> {
  await fs.mkdir(cardsDir, { recursive: true });
  await fs.writeFile(path.join(cardsDir, name), content, 'utf-8');
}

function makeCard(overrides: Partial<Card> = {}): Card {
  return {
    id: 'refresh-token' as CardId,
    title: 'リフレッシュトークン対応',
    created: '2026-09-01T00:00:00.000Z',
    explored: false,
    implStartedAt: null,
    change: null,
    branch: null,
    mr: null,
    stageOverride: null,
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
      'explored: true',
      'change: refresh-token',
      'mr: 42',
      'stageOverride: done',
      '---',
      '',
      '## アイデア',
      '本文',
    ].join('\n');

    const card = parseCard('/tmp/refresh-token.md', raw);

    expect(card).not.toBeNull();
    expect(card?.explored).toBe(true);
    expect(card?.change).toBe('refresh-token');
    expect(card?.mr).toBe(42);
    expect(card?.stageOverride).toBe('done');
    expect(card?.body).toBe('## アイデア\n本文');
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

    expect(card?.explored).toBe(false);
    expect(card?.implStartedAt).toBeNull();
    expect(card?.change).toBeNull();
    expect(card?.stageOverride).toBeNull();
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

  it('不正なステージ値のカードは読み込まない', () => {
    const raw = ['---', 'id: bad', 'title: 不正', 'stageOverride: nonsense', '---', ''].join('\n');

    expect(parseCard('/tmp/bad.md', raw)).toBeNull();
  });
});

describe('serializeCard', () => {
  it('往復しても値が変わらない', () => {
    const card = makeCard({
      explored: true,
      implStartedAt: '2026-09-04T10:12:00.000Z',
      change: 'refresh-token' as ChangeName,
      branch: 'feat/refresh-token',
      mr: 42 as MergeRequestIid,
      stageOverride: 'ai-pr',
      body: '## アイデア\n本文',
    });

    const restored = parseCard('/tmp/refresh-token.md', serializeCard(card));

    expect(restored).toEqual(card);
  });

  it('null のフィールドを保ったまま書き出せる', () => {
    const restored = parseCard('/tmp/refresh-token.md', serializeCard(makeCard()));

    expect(restored?.change).toBeNull();
    expect(restored?.mr).toBeNull();
    expect(restored?.stageOverride).toBeNull();
  });
});

// ============================================================
// リポジトリ
// ============================================================

describe('FsCardRepository', () => {
  it('ディレクトリが無ければ空配列を返す', async () => {
    expect(await new FsCardRepository(cardsDir).findAll()).toEqual([]);
  });

  it('作成したカードを読み戻せる', async () => {
    const repository = new FsCardRepository(cardsDir);
    const card = makeCard();

    expect(await repository.create(card)).toBe(true);
    expect(await repository.findById(card.id)).toEqual(card);
  });

  it('同じ ID では二重に作成できない', async () => {
    const repository = new FsCardRepository(cardsDir);

    expect(await repository.create(makeCard())).toBe(true);
    expect(await repository.create(makeCard({ title: '別のタイトル' }))).toBe(false);
    expect((await repository.findById('refresh-token' as CardId))?.title).toBe(
      'リフレッシュトークン対応'
    );
  });

  it('存在しないカードは保存できない', async () => {
    expect(await new FsCardRepository(cardsDir).save(makeCard())).toBe(false);
  });

  it('保存で内容を更新できる', async () => {
    const repository = new FsCardRepository(cardsDir);
    await repository.create(makeCard());

    expect(await repository.save(makeCard({ explored: true }))).toBe(true);
    expect((await repository.findById('refresh-token' as CardId))?.explored).toBe(true);
  });

  it('壊れたファイルは読み飛ばして残りを返す', async () => {
    await writeCardFile('good.md', '---\nid: good\ntitle: 正常\n---\n');
    await writeCardFile('broken.md', '---\nid: mismatched-id\ntitle: 壊れ\n---\n');

    const cards = await new FsCardRepository(cardsDir).findAll();

    expect(cards.map((card) => card.id)).toEqual(['good']);
  });

  it('md 以外のファイルは無視する', async () => {
    await writeCardFile('note.txt', 'ただのテキスト');
    await writeCardFile('real.md', '---\nid: real\ntitle: カード\n---\n');

    const cards = await new FsCardRepository(cardsDir).findAll();

    expect(cards.map((card) => card.id)).toEqual(['real']);
  });

  it('作成日時の昇順で返す', async () => {
    const repository = new FsCardRepository(cardsDir);
    await repository.create(
      makeCard({ id: 'later' as CardId, created: '2026-09-05T00:00:00.000Z' })
    );
    await repository.create(
      makeCard({ id: 'earlier' as CardId, created: '2026-09-01T00:00:00.000Z' })
    );

    expect((await repository.findAll()).map((card) => card.id)).toEqual(['earlier', 'later']);
  });

  it('存在しない ID には null を返す', async () => {
    expect(await new FsCardRepository(cardsDir).findById('missing' as CardId)).toBeNull();
  });
});
