import { describe, expect, it, vi } from 'vitest';
import { cardFileCodec, isStoreFilePath } from '../repositories/card-file-codec.js';
import { parseOrderData } from '../repositories/card-files.js';

describe('cardFileCodec', () => {
  it('形の版と並び順を YAML のファイルと行き来する', () => {
    const meta = cardFileCodec.toFile('board', 'meta', { version: 3 });
    expect(meta).toEqual({ path: '.ai-board/board.yaml', content: 'version: 3\n' });
    expect(cardFileCodec.toDocument(meta.path, meta.content)).toEqual({
      collection: 'board',
      id: 'meta',
      data: { version: 3 },
    });

    const order = cardFileCodec.toFile('order', 'order', { divider: 2, ranks: { a: 1 } });
    expect(order.path).toBe('.ai-board/order.yaml');
    expect(cardFileCodec.toDocument(order.path, order.content)?.data).toEqual({
      divider: 2,
      ranks: { a: 1 },
    });
  });

  it('壊れた order.yaml は読み飛ばさず、並び順を読む側で失敗させる', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const doc = cardFileCodec.toDocument('.ai-board/order.yaml', 'ranks: [');
    expect(doc?.collection).toBe('order');
    expect(parseOrderData(doc?.data).ok).toBe(false);
    warn.mockRestore();
  });

  it('カードの文書を card.md と行き来する', () => {
    const data = {
      id: 'idea-a',
      title: 'アイデア A',
      created: '2026-11-22T00:00:00.000Z',
      skipGates: [],
      branch: null,
      pr: null,
      body: '## アイデア\n\n本文',
    };
    const file = cardFileCodec.toFile('cards', 'idea-a', data);
    expect(file.path).toBe('.ai-board/cards/idea-a/card.md');
    expect(cardFileCodec.toDocument(file.path, file.content)).toEqual({
      collection: 'cards',
      id: 'idea-a',
      data,
    });
  });

  it('判断の文書を log/ のファイルと行き来する', () => {
    const id = 'idea-a.20261122T010203.000Z.plan.submit';
    const file = cardFileCodec.toFile('log', id, { reason: '提出の理由' });
    expect(file.path).toBe('.ai-board/cards/idea-a/log/20261122T010203.000Z.plan.submit.md');
    const doc = cardFileCodec.toDocument(file.path, file.content);
    expect(doc?.collection).toBe('log');
    expect(doc?.id).toBe(id);
    expect(doc?.data).toMatchObject({ cardId: 'idea-a', gate: 'plan', reason: '提出の理由' });
  });

  it('計画・不正な ID・名前の読めない判断は文書にしない', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(cardFileCodec.toDocument('.ai-board/cards/idea-a/plan.md', '# 計画')).toBeNull();
    expect(cardFileCodec.toDocument('.ai-board/cards/Bad_ID/card.md', '---\n---\n')).toBeNull();
    expect(cardFileCodec.toDocument('.ai-board/cards/idea-a/log/なにか.md', '')).toBeNull();
    warn.mockRestore();
  });

  it('手元に置くコレクションは git の置き場所に書かない', () => {
    expect(() => cardFileCodec.toFile('loop', 'x', {})).toThrow();
  });
});

describe('isStoreFilePath', () => {
  it('置き場所のファイルだけを真にする', () => {
    expect(isStoreFilePath('.ai-board/board.yaml')).toBe(true);
    expect(isStoreFilePath('.ai-board/order.yaml')).toBe(true);
    expect(isStoreFilePath('.ai-board/cards/idea-a/card.md')).toBe(true);
    expect(isStoreFilePath('.ai-board/cards/idea-a/log/20261122T010203.000Z.plan.submit.md')).toBe(
      true
    );
    expect(isStoreFilePath('.ai-board/cards/idea-a/plan.md')).toBe(false);
    expect(isStoreFilePath('.ai-board/seed/idea-a.md')).toBe(false);
    expect(isStoreFilePath('src/cli.ts')).toBe(false);
  });
});
