import type { LoopStep } from './loop-step.js';

// ============================================================
// ボードのログ — ループの手と判断の記録を 1 本の時系列にする
// ============================================================

/**
 * ログに使うカードの形。ボードのカード（`BoardCard`）から要る項目だけを受け取る。
 *
 * `src/shared/` はサーバと web の両方から読むので、サーバの型は引かずに使う形だけを書く。
 * `reviews[].gate` / `kind` は `ReviewGate` / `ReviewKind`（`src/cards/models/review.ts`）の値をそのまま運ぶ。
 */
export interface LogCard {
  readonly id: string;
  readonly title: string;
  readonly reviews: readonly {
    readonly at: string;
    readonly gate: string;
    readonly kind: string;
    readonly reason: string;
  }[];
  readonly loopSteps: readonly Pick<
    LoopStep,
    'action' | 'step' | 'startedAt' | 'result' | 'tokens' | 'durationMs'
  >[];
}

interface LogEntryBase {
  /** 並べる時刻。ループの手は始めた時刻、判断は書いた時刻 */
  readonly at: string;
  readonly cardId: string;
  readonly cardTitle: string;
}

/** ループの 1 手（本筋のセッションが手を始めてから終えるまで） */
export interface LoopLogEntry extends LogEntryBase {
  readonly kind: 'loop';
  readonly step: LogCard['loopSteps'][number];
}

/** 判断の記録（`## レビュー` の 1 件。提出・再提出・承認・否決・保留・中止） */
export interface ReviewLogEntry extends LogEntryBase {
  readonly kind: 'review';
  readonly review: LogCard['reviews'][number];
}

export type BoardLogEntry = LoopLogEntry | ReviewLogEntry;

export interface BoardLog {
  /** 新しい順に、多くても `limit` 件 */
  readonly entries: readonly BoardLogEntry[];
  /** `limit` を超えて省いた古い記録の件数 */
  readonly omitted: number;
}

/** ログに載せる件数の既定。周を回すほど伸びるので、古いものは省く */
export const BOARD_LOG_LIMIT = 200;

/**
 * 全カードのループの手と判断の記録を、新しい順の 1 本の時系列にする（純関数。今の時刻は読まない）。
 *
 * 同じ時刻のものは、カード ID の順、判断より先にループの手の順に並べ、同じデータからは同じ並びにする。
 * 読めない時刻の記録は最後に回す。中止したカードの記録も載せる（中止そのものが判断の記録である）。
 */
export function buildBoardLog(
  cards: readonly LogCard[],
  limit: number = BOARD_LOG_LIMIT
): BoardLog {
  const entries: BoardLogEntry[] = [];
  for (const card of cards) {
    const base = { cardId: card.id, cardTitle: card.title };
    for (const step of card.loopSteps) {
      entries.push({ ...base, kind: 'loop', at: step.startedAt, step });
    }
    for (const review of card.reviews) {
      entries.push({ ...base, kind: 'review', at: review.at, review });
    }
  }

  const sorted = entries
    .map((entry, index) => ({ entry, index, time: Date.parse(entry.at) }))
    .sort((a, b) => compareEntries(a, b))
    .map(({ entry }) => entry);
  const kept = Math.max(0, limit);

  return { entries: sorted.slice(0, kept), omitted: Math.max(0, sorted.length - kept) };
}

const KIND_ORDER: Record<BoardLogEntry['kind'], number> = { loop: 0, review: 1 };

function compareEntries(
  a: { readonly entry: BoardLogEntry; readonly index: number; readonly time: number },
  b: { readonly entry: BoardLogEntry; readonly index: number; readonly time: number }
): number {
  const aValid = !Number.isNaN(a.time);
  const bValid = !Number.isNaN(b.time);
  if (aValid !== bValid) return aValid ? -1 : 1;
  if (aValid && a.time !== b.time) return b.time - a.time;
  if (a.entry.cardId !== b.entry.cardId) return a.entry.cardId < b.entry.cardId ? -1 : 1;
  if (a.entry.kind !== b.entry.kind) return KIND_ORDER[a.entry.kind] - KIND_ORDER[b.entry.kind];
  // 同じカード・同じ種類・同じ時刻は、書かれた順（新しい順なので後に書いたものを上）
  return b.index - a.index;
}
