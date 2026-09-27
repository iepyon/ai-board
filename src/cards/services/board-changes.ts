import { isDeepStrictEqual } from 'node:util';
import { err, ok, type Result } from '../../shared/result.js';
import type { CardId } from '../../shared/schemas/common.js';
import type { Card } from '../models/card.js';
import type { BoardSnapshot, CardFieldChanges, ChangeFile, ChangeOp } from '../models/change.js';
import { EMPTY_SNAPSHOT } from '../models/change.js';
import type { ChangeFileMalformed } from '../errors/card-errors.js';

// ============================================================
// データのマイグレーション — 操作の適用と差分（純関数）
// ============================================================

/** 差分を取る列。`id` はカードを指すキーなので含めない */
const FIELDS = [
  'title',
  'created',
  'startedAt',
  'skipGates',
  'branch',
  'mr',
  'rank',
  'body',
] as const satisfies readonly (keyof CardFieldChanges)[];

/**
 * 変更ファイルを名前の順に流す。
 *
 * 同じカードの同じ列を複数のファイルが書けば、名前の順で後のものが勝つ。
 * 並列のワークツリーでの順序の食い違いは受け入れている（計画 `board-seed` の Non-Goals）。
 */
export function replay(
  files: readonly ChangeFile[],
  from: BoardSnapshot = EMPTY_SNAPSHOT
): Result<BoardSnapshot, ChangeFileMalformed> {
  let snapshot = from;

  for (const file of [...files].sort((a, b) => compareNames(a.name, b.name))) {
    const applied = applyOps(snapshot, file.ops);
    if (!applied.ok) {
      return err({ type: 'ChangeFileMalformed', file: file.name, reason: applied.error });
    }
    snapshot = applied.value;
  }

  return ok(snapshot);
}

/** 状態に操作を順に当てる。失敗の理由は文字列で返し、呼び出し側がファイル名を添える */
export function applyOps(
  snapshot: BoardSnapshot,
  ops: readonly ChangeOp[]
): Result<BoardSnapshot, string> {
  const cards = new Map(snapshot.cards);
  let divider = snapshot.divider;

  for (const op of ops) {
    if (op.kind === 'divider') {
      divider = op.rank;
      continue;
    }

    const next = applyCardOp(cards.get(op.id), op.id, op.set);
    if (next === null) {
      return err(`カード ${op.id} が無く、作るための title と created がありません`);
    }
    cards.set(op.id, next);
  }

  return ok({ cards, divider });
}

function applyCardOp(current: Card | undefined, id: CardId, set: CardFieldChanges): Card | null {
  if (current !== undefined) {
    return { ...current, ...set };
  }

  if (set.title === undefined || set.created === undefined) {
    return null;
  }

  return {
    id,
    startedAt: null,
    skipGates: [],
    branch: null,
    mr: null,
    rank: null,
    body: '',
    ...set,
    title: set.title,
    created: set.created,
  };
}

/**
 * `base` から `current` へ進める操作を作る。変わった列だけを書く。
 *
 * 行をまるごと書くと、別のブランチが別の列に加えた変更を後から消してしまう。
 * `base` にあって `current` に無いカードは無視する（カードを消す操作は持たない）。
 */
export function diffSnapshots(base: BoardSnapshot, current: BoardSnapshot): ChangeOp[] {
  const ops: ChangeOp[] = [];

  for (const id of [...current.cards.keys()].sort()) {
    const card = current.cards.get(id);
    if (card === undefined) continue;

    const set = diffCard(base.cards.get(id), card);
    if (Object.keys(set).length > 0) {
      ops.push({ kind: 'card', id, set });
    }
  }

  if (current.divider !== null && current.divider !== base.divider) {
    ops.push({ kind: 'divider', rank: current.divider });
  }

  return ops;
}

/**
 * 新しいカードを作るときに省ける列の既定値（`applyCardOp` の既定値と揃える）。
 * ここに無い列（title / created）は、新しいカードでは必ず書く。
 */
const CREATE_DEFAULTS: Partial<Record<(typeof FIELDS)[number], unknown>> = {
  startedAt: null,
  skipGates: [],
  branch: null,
  mr: null,
  rank: null,
  body: '',
};

function diffCard(before: Card | undefined, after: Card): CardFieldChanges {
  const set: Record<string, unknown> = {};

  for (const field of FIELDS) {
    const changed =
      before === undefined
        ? !(field in CREATE_DEFAULTS) || !isDeepStrictEqual(CREATE_DEFAULTS[field], after[field])
        : !isDeepStrictEqual(before[field], after[field]);

    if (changed) {
      set[field] = after[field];
    }
  }

  return set as CardFieldChanges;
}

/** DB と変更ファイルの状態のどこが違うかを、カード ID と区切り線で返す */
export function describeDiff(ops: readonly ChangeOp[]): { cardIds: string[]; divider: boolean } {
  return {
    cardIds: ops.flatMap((op) => (op.kind === 'card' ? [op.id] : [])),
    divider: ops.some((op) => op.kind === 'divider'),
  };
}

/** ファイル名の順。ロケールに依らない単純な比較にする（どの環境でも同じ順で流すため） */
export function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
