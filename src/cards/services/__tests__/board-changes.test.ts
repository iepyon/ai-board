import { describe, it, expect } from 'vitest';
import type { CardId } from '../../../shared/schemas/common.js';
import type { Card } from '../../models/card.js';
import type { BoardSnapshot, ChangeFile } from '../../models/change.js';
import { EMPTY_SNAPSHOT } from '../../models/change.js';
import { applyOps, describeDiff, diffSnapshots, replay } from '../board-changes.js';

function makeCard(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id: id as CardId,
    title: `${id} のタイトル`,
    created: '2026-09-27T00:00:00.000Z',
    startedAt: null,
    skipGates: [],
    branch: null,
    mr: null,
    rank: null,
    body: '',
    ...overrides,
  };
}

function snapshot(cards: Card[], divider: number | null = null): BoardSnapshot {
  return { cards: new Map(cards.map((card) => [card.id, card])), divider };
}

describe('applyOps', () => {
  it('無いカードは title と created から作り、残りの列は既定値にする', () => {
    const result = applyOps(EMPTY_SNAPSHOT, [
      {
        kind: 'card',
        id: 'a' as CardId,
        set: { title: 'A', created: '2026-09-27T00:00:00.000Z', body: '本文' },
      },
    ]);

    expect(result.ok && result.value.cards.get('a' as CardId)).toEqual(
      makeCard('a', { title: 'A', body: '本文' })
    );
  });

  it('あるカードには書いた列だけを上書きする', () => {
    const result = applyOps(snapshot([makeCard('a', { body: '本文', rank: 1 })]), [
      { kind: 'card', id: 'a' as CardId, set: { rank: 2, branch: 'feat/a' } },
    ]);

    expect(result.ok && result.value.cards.get('a' as CardId)).toEqual(
      makeCard('a', { body: '本文', rank: 2, branch: 'feat/a' })
    );
  });

  it('null を書いた列は値を消す', () => {
    const result = applyOps(snapshot([makeCard('a', { branch: 'feat/a', mr: 3 as never })]), [
      { kind: 'card', id: 'a' as CardId, set: { branch: null, mr: null } },
    ]);

    expect(result.ok && result.value.cards.get('a' as CardId)).toEqual(makeCard('a'));
  });

  it('無いカードを title / created なしで作ろうとしたら失敗する', () => {
    const result = applyOps(EMPTY_SNAPSHOT, [
      { kind: 'card', id: 'a' as CardId, set: { rank: 1 } },
    ]);

    expect(result.ok).toBe(false);
  });

  it('区切り線の rank を書く', () => {
    const result = applyOps(EMPTY_SNAPSHOT, [{ kind: 'divider', rank: 1.5 }]);

    expect(result.ok && result.value.divider).toBe(1.5);
  });

  it('元の状態は書き換えない', () => {
    const before = snapshot([makeCard('a')]);
    applyOps(before, [{ kind: 'card', id: 'a' as CardId, set: { rank: 9 } }]);

    expect(before.cards.get('a' as CardId)?.rank).toBeNull();
  });
});

describe('diffSnapshots', () => {
  it('変わった列だけを書く', () => {
    const base = snapshot([makeCard('a', { body: '本文', rank: 1 })]);
    const current = snapshot([makeCard('a', { body: '本文', rank: 2 })]);

    expect(diffSnapshots(base, current)).toEqual([{ kind: 'card', id: 'a', set: { rank: 2 } }]);
  });

  it('新しいカードは title / created と、既定値と違う列を書く', () => {
    const current = snapshot([makeCard('a', { body: '本文', skipGates: ['plan'] })]);

    expect(diffSnapshots(EMPTY_SNAPSHOT, current)).toEqual([
      {
        kind: 'card',
        id: 'a',
        set: {
          title: 'a のタイトル',
          created: '2026-09-27T00:00:00.000Z',
          skipGates: ['plan'],
          body: '本文',
        },
      },
    ]);
  });

  it('消えたカードは無視する（カードを消す操作は持たない）', () => {
    expect(diffSnapshots(snapshot([makeCard('a')]), EMPTY_SNAPSHOT)).toEqual([]);
  });

  it('区切り線が変わったら書く。未設定に戻ることは無いので null は書かない', () => {
    expect(diffSnapshots(snapshot([], 1), snapshot([], 2))).toEqual([{ kind: 'divider', rank: 2 }]);
    expect(diffSnapshots(snapshot([], 1), snapshot([], null))).toEqual([]);
  });

  it('カードは ID の順に並べる（同じ DB からは同じファイルを作る）', () => {
    const current = snapshot([makeCard('b'), makeCard('a')]);

    expect(diffSnapshots(EMPTY_SNAPSHOT, current).map((op) => op.kind === 'card' && op.id)).toEqual(
      ['a', 'b']
    );
  });

  it('差分を当てれば元の状態に戻る', () => {
    const base = snapshot([makeCard('a', { rank: 1 }), makeCard('b')], 5);
    const current = snapshot(
      [makeCard('a', { rank: 3, body: 'x' }), makeCard('b'), makeCard('c', { branch: 'c' })],
      7
    );

    const applied = applyOps(base, diffSnapshots(base, current));

    expect(applied.ok && applied.value).toEqual(current);
  });
});

describe('replay', () => {
  const create = (name: string, id: string, rank: number): ChangeFile => ({
    name,
    ops: [
      {
        kind: 'card',
        id: id as CardId,
        set: { title: id, created: '2026-09-27T00:00:00.000Z', rank },
      },
    ],
  });

  it('名前の順に流し、同じ列は後の名前が勝つ（渡した順には依らない）', () => {
    const result = replay([
      create('20260927T000002000Z-b.yaml', 'a', 2),
      create('20260927T000001000Z-a.yaml', 'a', 1),
    ]);

    expect(result.ok && result.value.cards.get('a' as CardId)?.rank).toBe(2);
  });

  it('当てられない操作があれば、そのファイル名を添えて失敗する', () => {
    const result = replay([
      { name: 'broken.yaml', ops: [{ kind: 'card', id: 'a' as CardId, set: { rank: 1 } }] },
    ]);

    expect(result).toEqual({
      ok: false,
      error: { type: 'ChangeFileMalformed', file: 'broken.yaml', reason: expect.any(String) },
    });
  });
});

describe('describeDiff', () => {
  it('差分のカード ID と区切り線の有無を返す', () => {
    expect(
      describeDiff([
        { kind: 'card', id: 'a' as CardId, set: { rank: 1 } },
        { kind: 'divider', rank: 1 },
      ])
    ).toEqual({ cardIds: ['a'], divider: true });
  });
});
