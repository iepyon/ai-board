import { describe, it, expect, beforeEach } from 'vitest';
import { createMoveCardCommand } from '../commands/move-card.command.js';
import { RANK_STEP, compareCards } from '../../services/card-order.js';
import type { CardRepository } from '../../repositories/card.repository.js';
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

let repository: InMemoryCardRepository;

function addCard(id: string, day: number, rank: number | null = null): void {
  repository.cards.set(id, {
    id: id as CardId,
    title: id,
    created: `2026-09-${String(day).padStart(2, '0')}T00:00:00.000Z`,
    startedAt: null,
    skipGates: [],
    branch: null,
    mr: null,
    forge: null,
    rank,
    body: '',
  });
}

function move(id: string, after: string | null, before: string | null) {
  return createMoveCardCommand(repository)({
    id: id as CardId,
    after: after as CardId | null,
    before: before as CardId | null,
  });
}

beforeEach(() => {
  repository = new InMemoryCardRepository();
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
