import { err, isErr, ok, type Result } from '../../../shared/result.js';
import type { CardId, Stage } from '../../../shared/schemas/common.js';
import { withSkipGate } from '../../../shared/stage-gates.js';
import type { ReviewGate } from '../../../cards/models/review.js';
import type { Card } from '../../../cards/models/card.js';
import type { CardDependencies } from '../../../cards/composition.js';
import { transactCardWrite } from '../../../cards/usecases/commands/transact-card-write.js';
import type { OrderRef } from '../../../cards/usecases/commands/move-in-order.js';
import type { IdeaDividerPosition } from '../../../cards/usecases/commands/move-idea-divider.command.js';
import type { CommitMessage, DataStore } from '../../../infrastructure/data-store.js';
import type { Board } from '../../models/board-card.js';
import type { DecideError, GetBoardError } from '../../errors/board-errors.js';
import {
  guardMove,
  guardMoveDivider,
  guardReview,
  guardSkip,
  guardStartedAt,
} from '../../services/decision-guards.js';

// ============================================================
// 人の判断を書く — `ai-board decide` の段取り
// ============================================================

export interface DecideDependencies {
  /**
   * ボードを導出する。PR の状態は呼び出し側が頭で 1 回取り直したものを使い、ここでは問い合わせない。
   * 書き込みの 1 操作の中で呼ぶので、`transact` を呼ばない
   */
  readonly loadBoard: () => Promise<Result<Board, GetBoardError>>;
  /** データのワークツリー。ボードの導出・検査・書き込みを `transact` の 1 回の中で走らせる */
  readonly store: Pick<DataStore, 'transact'>;
  /** `store` のデータのワークツリーを読み書きするカードの依存。`transact` の中で呼ぶ */
  readonly cards: Pick<
    CardDependencies,
    'appendReviewCommand' | 'updateCardMetaCommand' | 'moveCardCommand' | 'moveIdeaDividerCommand'
  >;
}

/**
 * 書いた判断と列の移り。`from` は書く直前（`transact` の最後の試み）の列、
 * `to` は書いた後にボードを読み直した列で、読めなければ（ボードが読めない、カードが無い）null
 */
export interface Decided {
  readonly id: CardId;
  /** 何を書いたか（`plan 承認`、`着手`、`plan を飛ばす宣言を入れる` など）。コミットのメッセージにも使う */
  readonly what: string;
  readonly from: Stage;
  readonly to: Stage | null;
}

export interface ReviewDecisionInput {
  readonly id: CardId;
  readonly kind: '承認' | '差し戻し' | '中止';
  /** 前後の空白を落とした理由。無ければ空文字 */
  readonly reason: string;
  readonly at: Date;
}

export interface SkipDecisionInput {
  readonly id: CardId;
  readonly gate: ReviewGate;
  /** true なら宣言を外す */
  readonly remove: boolean;
}

export interface MoveDecisionInput {
  readonly id: CardId;
  /** 直前の項目。表の先頭なら null */
  readonly after: OrderRef | null;
  /** 直後の項目。表の末尾なら null */
  readonly before: OrderRef | null;
}

export interface MoveDividerDecisionInput {
  readonly after: CardId | null;
  readonly before: CardId | null;
}

/**
 * 人の判断を書く口。引数の形（カード ID・`--gate`・`--after` / `--before` の値、自分自身を隣に指定）は、
 * 呼び出し側がボードを読む前に確かめておく。
 */
export interface DecideCommands {
  /** 承認 / 差し戻し / 中止 */
  readonly review: (input: ReviewDecisionInput) => Promise<Result<Decided, DecideError>>;
  /** 着手（アイデア → 計画提案中）。`at` を `startedAt` に書く */
  readonly start: (input: {
    readonly id: CardId;
    readonly at: Date;
  }) => Promise<Result<Decided, DecideError>>;
  /** 着手を戻す（計画提案中 → アイデア） */
  readonly unstart: (input: { readonly id: CardId }) => Promise<Result<Decided, DecideError>>;
  /** 飛ばす宣言の出し入れ。ほかのゲートの宣言は保つ */
  readonly skip: (input: SkipDecisionInput) => Promise<Result<Decided, DecideError>>;
  /** アイデアの表の並べ替え */
  readonly move: (input: MoveDecisionInput) => Promise<Result<Card, DecideError>>;
  /** アイデアの表の区切り線を動かす */
  readonly moveDivider: (
    input: MoveDividerDecisionInput
  ) => Promise<Result<IdeaDividerPosition, DecideError>>;
}

/** 書いた判断。`before` は書く直前の列 */
interface Written {
  readonly id: CardId;
  readonly what: string;
  readonly before: Stage;
}

/**
 * 人の判断（承認 / 差し戻し / 中止、着手 / 着手を戻す、飛ばす宣言、並べ替え）を書く usecase を組む。
 *
 * どの判断も、ボードの導出・検査（`decision-guards.ts`）・書き込みを、書き込みの 1 操作（`transactCardWrite`）の中で走らせる。
 * コミットのメッセージもここで決める。列の移る判断は、書いた後にボードを読み直して移った先の列を返す。
 *
 * 誰が使ってよいかは構造では分けない。人と、人がこの会話で自分の言葉で頼んだ Claude（`board-decide` のスキル）が使い、
 * `board-reviewer` とループの周の中では使わない。この境界は手順書の決まりで守る（ADR 0007）。
 */
export function createDecideCommands(deps: DecideDependencies): DecideCommands {
  const decide = <T>(
    message: CommitMessage<T>,
    op: (board: Board) => Promise<Result<T, DecideError>>
  ) => inTransaction(deps, message, op);

  /** 書いた後のボードで、移った先の列を読む */
  const settle = async (
    written: Result<Written, DecideError>
  ): Promise<Result<Decided, DecideError>> => {
    if (!written.ok) return written;
    const { id, what, before } = written.value;

    const after = await deps.loadBoard();
    const to = after.ok ? (after.value.cards.find((c) => c.id === id)?.stage ?? null) : null;
    return ok({ id, what, from: before, to });
  };

  const startedAt = (
    id: CardId,
    move: {
      readonly from: Stage;
      readonly to: Stage;
      readonly label: string;
      readonly startedAt: string | null;
    }
  ) =>
    decide<Written>(`data: ${id} の startedAt を変える`, async (board) => {
      const guarded = guardStartedAt(board, { id, from: move.from, to: move.to });
      if (!guarded.ok) return guarded;

      const written = await deps.cards.updateCardMetaCommand({
        id,
        patch: { startedAt: move.startedAt },
      });
      return written.ok ? ok({ id, what: move.label, before: guarded.value.stage }) : written;
    }).then(settle);

  return {
    review: ({ id, kind, reason, at }) =>
      decide<Written>(
        (written) => `data: ${id} に ${written.what} を足す`,
        async (board) => {
          const target = guardReview(board, { id, kind, reason });
          if (!target.ok) return target;
          const { card, gate } = target.value;

          const written = await deps.cards.appendReviewCommand({ id, gate, kind, reason, at });
          return written.ok ? ok({ id, what: `${gate} ${kind}`, before: card.stage }) : written;
        }
      ).then(settle),

    start: ({ id, at }) =>
      startedAt(id, { from: 'idea', to: 'planning', label: '着手', startedAt: at.toISOString() }),

    unstart: ({ id }) =>
      startedAt(id, { from: 'planning', to: 'idea', label: '着手を戻す', startedAt: null }),

    skip: ({ id, gate, remove }) =>
      decide<Written>(`data: ${id} の skipGates を変える`, async (board) => {
        const guarded = guardSkip(board, { id });
        if (!guarded.ok) return guarded;
        const card = guarded.value;

        // 宣言はゲートごとに出し入れし、ほかのゲートの宣言は保つ
        const skipGates = withSkipGate(card.skipGates, gate, !remove);

        const written = await deps.cards.updateCardMetaCommand({ id, patch: { skipGates } });
        return written.ok
          ? ok({
              id,
              what: `${gate} を飛ばす宣言を${remove ? '外す' : '入れる'}`,
              before: card.stage,
            })
          : written;
      }).then(settle),

    move: ({ id, after, before }) =>
      decide(`data: ${id} を並べ替える`, async (board) => {
        const guarded = guardMove(board, { id, after, before });
        if (!guarded.ok) return guarded;

        return deps.cards.moveCardCommand({ id, after, before });
      }),

    moveDivider: ({ after, before }) =>
      decide('data: 区切り線を動かす', async (board) => {
        const guarded = guardMoveDivider(board, { after, before });
        if (!guarded.ok) return guarded;

        return deps.cards.moveIdeaDividerCommand({ after, before });
      }),
  };
}

/**
 * ボードの導出・検査・書き込みを、書き込みの 1 操作（`transactCardWrite`）の中で走らせる。
 *
 * push が拒否されると、`transact` が取り直した最新の状態で `op` を頭から呼び直すので、ボードを導き直して検査からやり直す。
 * 検査の後、書くまでの間にほかのセッションがカードに書いても、古いボードに対する検査のまま書かない（ADR 0010）。
 * `op` は呼び直されるので、標準出力にも標準エラーにも書かない。拒むときは Err を返す（コミットしない）。
 */
function inTransaction<T>(
  deps: DecideDependencies,
  message: CommitMessage<T>,
  op: (board: Board) => Promise<Result<T, DecideError>>
): Promise<Result<T, DecideError>> {
  return transactCardWrite(deps.store, message, async () => {
    const board = await deps.loadBoard();
    if (isErr(board)) return err({ type: 'BoardUnreadable' as const, reason: board.error.reason });
    return op(board.value);
  });
}
