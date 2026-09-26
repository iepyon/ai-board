import { describe, it, expect, beforeEach } from 'vitest';
import { createMoveCardCommand } from '../commands/move-card.command.js';
import { createMoveIdeaDividerCommand } from '../commands/move-idea-divider.command.js';
import { RANK_STEP, compareCards, effectiveRank } from '../../services/card-order.js';
import { DIVIDER_ID } from '../../../shared/card-reorder.js';
import type { CardRepository } from '../../repositories/card.repository.js';
import type { IdeaDividerRepository } from '../../repositories/idea-divider.repository.js';
import type { Card } from '../../models/card.js';
import type { CardId } from '../../../shared/schemas/common.js';

// ============================================================
// インメモリのテストダブル
// ============================================================

class InMemoryCardRepository implements CardRepository {
  readonly cards = new Map<string, Card>();
  readonly saved: string[] = [];

  async findAll(): Promise<Card[]> {
    // 並び順に頼らないことを確かめるため、あえて逆順で返す
    return [...this.cards.values()].reverse();
  }

  async findById(id: CardId): Promise<Card | null> {
    return this.cards.get(id) ?? null;
  }

  async create(card: Card): Promise<boolean> {
    this.cards.set(card.id, card);
    return true;
  }

  async save(card: Card): Promise<boolean> {
    if (!this.cards.has(card.id)) return false;
    this.cards.set(card.id, card);
    this.saved.push(card.id);
    return true;
  }

  order(): string[] {
    return [...this.cards.values()].sort(compareCards).map((card) => card.id);
  }
}

class InMemoryIdeaDividerRepository implements IdeaDividerRepository {
  rank: number | null = null;
  writes = 0;

  async get(): Promise<number | null> {
    return this.rank;
  }

  async set(rank: number): Promise<void> {
    this.rank = rank;
    this.writes += 1;
  }
}

let repository: InMemoryCardRepository;
let divider: InMemoryIdeaDividerRepository;

function addCard(id: string, day: number, rank: number | null = null): void {
  repository.cards.set(id, {
    id: id as CardId,
    title: id,
    created: `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`,
    startedAt: null,
    skipGates: [],
    branch: null,
    mr: null,
    rank,
    body: '',
  });
}

function move(id: string, after: string | null, before: string | null) {
  return createMoveCardCommand({ cards: repository, divider })({
    id: id as CardId,
    after: after as CardId | null,
    before: before as CardId | null,
  });
}

function moveDivider(after: string | null, before: string | null) {
  return createMoveIdeaDividerCommand({ cards: repository, divider })({
    after: after as CardId | null,
    before: before as CardId | null,
  });
}

/** 区切り線を含めた並び。区切り線は DIVIDER_ID で表す */
function orderWithDivider(): string[] {
  const cards = [...repository.cards.values()];
  if (divider.rank === null) return cards.sort(compareCards).map((card) => card.id);

  const items = [...cards, { id: DIVIDER_ID, rank: divider.rank, created: '' }];
  return items.sort(compareCards).map((item) => item.id);
}

beforeEach(() => {
  repository = new InMemoryCardRepository();
  divider = new InMemoryIdeaDividerRepository();
  addCard('a', 1);
  addCard('b', 2);
  addCard('c', 3);
});

// ============================================================
// 並べ替え
// ============================================================

describe('moveCardCommand', () => {
  it('2 枚の間へ動かし、動かしたカードだけを書く', async () => {
    const result = await move('c', 'a', 'b');

    expect(result.ok).toBe(true);
    expect(repository.order()).toEqual(['a', 'c', 'b']);
    expect(repository.saved).toEqual(['c']);
  });

  it('先頭へ動かす', async () => {
    await move('c', null, 'a');

    expect(repository.order()).toEqual(['c', 'a', 'b']);
  });

  it('末尾へ動かす', async () => {
    await move('a', 'c', null);

    expect(repository.order()).toEqual(['b', 'c', 'a']);
  });

  it('列の隣どうしの間に差し込み、他の列のカードの相対順は変えない', async () => {
    // 同じ列に a と c があり、b は別の列にいる
    await move('c', null, 'a');

    const order = repository.order();
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('a'));
    expect(order.filter((id) => id !== 'c')).toEqual(['a', 'b']);
  });

  it('隣が両方 null なら何も書かない', async () => {
    const result = await move('a', null, null);

    expect(result.ok).toBe(true);
    expect(repository.saved).toEqual([]);
  });

  it('隙間が尽きたら全カードを振り直してから差し込む', async () => {
    repository.cards.clear();
    addCard('a', 1, 10);
    addCard('b', 1, 10);
    addCard('c', 2);

    await move('c', 'a', 'b');

    expect(repository.order()).toEqual(['a', 'c', 'b']);
    expect(repository.cards.get('a')?.rank).toBe(RANK_STEP);
  });

  it('対象のカードが無ければ CardNotFound', async () => {
    const result = await move('nope', 'a', null);

    expect(result).toEqual({ ok: false, error: { type: 'CardNotFound', id: 'nope' } });
  });

  it('隣のカードが無ければ CardNotFound', async () => {
    const result = await move('a', 'b', 'nope');

    expect(result).toEqual({ ok: false, error: { type: 'CardNotFound', id: 'nope' } });
  });

  it('隣が逆順なら StaleOrder を返し、何も書かない', async () => {
    const result = await move('a', 'c', 'b');

    expect(result).toEqual({ ok: false, error: { type: 'StaleOrder', after: 'c', before: 'b' } });
    expect(repository.saved).toEqual([]);
  });
});

// ============================================================
// 区切り線
// ============================================================

describe('区切り線をまたぐ並べ替え', () => {
  it('区切り線を初めて置くと、隣のカードの間に位置を持つ', async () => {
    const result = await moveDivider('a', 'b');

    expect(result.ok && result.value.rank).not.toBe(null);
    expect(orderWithDivider()).toEqual(['a', DIVIDER_ID, 'b', 'c']);
    expect(repository.saved).toEqual([]);
  });

  it('区切り線を末尾へ置くと、その後に作られたカードは線の下に付く', async () => {
    await moveDivider('c', null);
    addCard('fresh', 20);

    expect(orderWithDivider()).toEqual(['a', 'b', 'c', DIVIDER_ID, 'fresh']);
  });

  it('カードを区切り線の直前へ動かす', async () => {
    await moveDivider('a', 'b');

    await move('c', 'a', DIVIDER_ID);

    expect(orderWithDivider()).toEqual(['a', 'c', DIVIDER_ID, 'b']);
  });

  it('カードを区切り線の直後へ動かす', async () => {
    await moveDivider('b', 'c');

    await move('a', DIVIDER_ID, 'c');

    expect(orderWithDivider()).toEqual(['b', DIVIDER_ID, 'a', 'c']);
  });

  it('区切り線が未設定なら、末尾に置いてからその下へ動かす', async () => {
    await move('a', DIVIDER_ID, null);

    expect(orderWithDivider()).toEqual(['b', 'c', DIVIDER_ID, 'a']);
    expect(divider.writes).toBe(1);
  });

  it('区切り線が未設定なら、末尾に置いてからその直前へ動かす', async () => {
    await move('a', 'c', DIVIDER_ID);

    expect(orderWithDivider()).toEqual(['b', 'c', 'a', DIVIDER_ID]);
  });

  it('対象のカードが無ければ、未設定の区切り線を書かない', async () => {
    const result = await move('nope', 'a', DIVIDER_ID);

    expect(result).toEqual({ ok: false, error: { type: 'CardNotFound', id: 'nope' } });
    expect(divider.writes).toBe(0);
  });

  it('隙間が尽きたら区切り線も一緒に振り直し、上下を入れ替えない', async () => {
    repository.cards.clear();
    addCard('a', 1, 10);
    addCard('b', 1, 11);
    addCard('c', 2, 20);
    // 10 の隣の浮動小数点数。a と区切り線の間には隙間が無い
    divider.rank = 10 + Number.EPSILON * 8;

    await move('c', 'a', DIVIDER_ID);

    expect(orderWithDivider()).toEqual(['a', 'c', DIVIDER_ID, 'b']);
    expect(divider.rank).toBe(2 * RANK_STEP);
  });

  it('区切り線を動かしてもカードの rank は変えない', async () => {
    await moveDivider(null, 'a');
    await moveDivider('b', 'c');

    expect(repository.saved).toEqual([]);
    const b = repository.cards.get('b') as Card;
    expect(effectiveRank(b)).toBeLessThan(divider.rank as number);
  });

  it('区切り線の隣のカードが無ければ CardNotFound', async () => {
    const result = await moveDivider('nope', null);

    expect(result).toEqual({ ok: false, error: { type: 'CardNotFound', id: 'nope' } });
    expect(divider.writes).toBe(0);
  });

  it('区切り線の隣が逆順なら StaleOrder', async () => {
    const result = await moveDivider('c', 'a');

    expect(result).toEqual({ ok: false, error: { type: 'StaleOrder', after: 'c', before: 'a' } });
  });
});
