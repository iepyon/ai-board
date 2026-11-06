import { err, ok, type Result } from '../../shared/result.js';
import type { CardId, Stage } from '../../shared/schemas/common.js';
import { DIVIDER_ID } from '../../shared/card-reorder.js';
import {
  decisionsFor,
  groupBySection,
  ideaRows,
  type Decision,
  type DecisionGate,
} from '../../shared/dashboard-sections.js';
import type { Board, BoardCard } from '../models/board-card.js';
import type { ForgeConnection } from '../models/mr-state.js';

// ============================================================
// 人の判断の検査 — `ai-board decide` が書く前に、導出したボードで確かめる純関数
// ============================================================

/**
 * 人の判断を書けない理由（discriminated union）。
 *
 * どれも導出済みの `Board` だけで決まる。引数の形（カード ID・`--after` / `--before` の値・`--gate`）の誤りは
 * ボードを読む前に CLI が拒むので、ここには入れない。人に読める 1 行への直しは CLI が持つ。
 */
export type DecideRefusal =
  /** GitHub に繋がらない。列と出せる判断が PR の状態に依るので、承認 / 否決 / 中止と着手 / 着手を戻すは拒む */
  | {
      readonly type: 'ForgeUnavailable';
      readonly action: 'review' | 'startedAt';
      readonly forge: ForgeConnection;
    }
  | { readonly type: 'CardNotFound'; readonly id: CardId }
  /** そのカードに、その種別の判断が出ていない（`decisionsFor`） */
  | {
      readonly type: 'DecisionUnavailable';
      readonly id: CardId;
      readonly kind: Decision['kind'];
      readonly card: BoardCard;
    }
  | { readonly type: 'ReasonRequired'; readonly kind: Decision['kind'] }
  /** 今の列が `from` でないか、`to` へ入れられない（`droppableStages`） */
  | {
      readonly type: 'StageMismatch';
      readonly id: CardId;
      readonly from: Stage;
      readonly to: Stage;
      readonly card: BoardCard;
    }
  | { readonly type: 'CardAborted'; readonly id: CardId }
  /** アイデアの表に並んでいない（`ref` はカード ID か区切り線） */
  | { readonly type: 'NotInIdeaTable'; readonly ref: string };

/** 承認 / 否決 / 中止を書く先。ゲートは出ている判断（`decisionsFor`）から決まる */
export interface ReviewTarget {
  readonly card: BoardCard;
  readonly gate: DecisionGate;
}

/**
 * 承認 / 否決 / 中止を書けるか。そのカードに出ている判断（`decisionsFor`）だけを通す。
 *
 * 理由の要る判断（否決）は、空白だけの理由も拒む。
 */
export function guardReview(
  board: Board,
  input: { readonly id: CardId; readonly kind: Decision['kind']; readonly reason: string }
): Result<ReviewTarget, DecideRefusal> {
  if (board.forge.status !== 'connected') {
    return err({ type: 'ForgeUnavailable', action: 'review', forge: board.forge });
  }

  const card = findCard(board, input.id);
  if (!card.ok) return card;

  const decision = decisionsFor(card.value).find((d) => d.kind === input.kind);
  if (decision === undefined) {
    return err({ type: 'DecisionUnavailable', id: input.id, kind: input.kind, card: card.value });
  }
  if (decision.reasonRequired && input.reason.trim() === '') {
    return err({ type: 'ReasonRequired', kind: input.kind });
  }

  return ok({ card: card.value, gate: decision.gate });
}

/**
 * 着手 / 着手を戻すを書けるか。カードを隣の列へ入れるのと同じで、今の列が `from` にあり、
 * `to` へ入れられる（`droppableStages`）カードだけを通す。
 *
 * 列と入れられる列は PR の状態に依る（Draft の PR だけが計画の成果物のときなど）ので、GitHub に繋がらなければ拒む。
 */
export function guardStartedAt(
  board: Board,
  input: { readonly id: CardId; readonly from: Stage; readonly to: Stage }
): Result<BoardCard, DecideRefusal> {
  if (board.forge.status !== 'connected') {
    return err({ type: 'ForgeUnavailable', action: 'startedAt', forge: board.forge });
  }

  const card = findCard(board, input.id);
  if (!card.ok) return card;

  if (card.value.stage !== input.from || !card.value.droppableStages.includes(input.to)) {
    return err({ type: 'StageMismatch', ...input, card: card.value });
  }

  return card;
}

/** 飛ばす宣言を出し入れできるか。列に依らないので GitHub に繋がらなくても通し、中止したカードだけを拒む */
export function guardSkip(
  board: Board,
  input: { readonly id: CardId }
): Result<BoardCard, DecideRefusal> {
  const card = findCard(board, input.id);
  if (!card.ok) return card;

  if (card.value.aborted) return err({ type: 'CardAborted', id: input.id });

  return card;
}

/**
 * アイデアの表でカードを動かせるか。動かすカードと、`after` / `before`（区切り線か、`null` で端）が
 * どれもアイデアの表に並んでいるものだけを通す
 */
export function guardMove(
  board: Board,
  input: {
    readonly id: CardId;
    readonly after: string | null;
    readonly before: string | null;
  }
): Result<null, DecideRefusal> {
  const ideas = ideaIds(board);
  const unknown = [input.id, input.after, input.before].find(
    (ref) => ref !== null && ref !== DIVIDER_ID && !ideas.has(ref)
  );

  return unknown === undefined || unknown === null
    ? ok(null)
    : err({ type: 'NotInIdeaTable', ref: unknown });
}

/** アイデアの表の区切り線を動かせるか。`after` / `before`（`null` で端）がアイデアの表に並ぶカードだけを通す */
export function guardMoveDivider(
  board: Board,
  input: { readonly after: string | null; readonly before: string | null }
): Result<null, DecideRefusal> {
  const ideas = ideaIds(board);
  const unknown = [input.after, input.before].find((ref) => ref !== null && !ideas.has(ref));

  return unknown === undefined || unknown === null
    ? ok(null)
    : err({ type: 'NotInIdeaTable', ref: unknown });
}

function findCard(board: Board, id: CardId): Result<BoardCard, DecideRefusal> {
  const card = board.cards.find((c) => c.id === id);
  return card === undefined ? err({ type: 'CardNotFound', id }) : ok(card);
}

/** アイデアの表に並ぶカードの ID。`status` の `ideas` と同じ振り分け */
function ideaIds(board: Board): ReadonlySet<string> {
  const ideas = groupBySection(board.cards).idea;
  return new Set(
    ideaRows(ideas, board.ideaDivider).flatMap((row) => (row.kind === 'card' ? [row.id] : []))
  );
}
