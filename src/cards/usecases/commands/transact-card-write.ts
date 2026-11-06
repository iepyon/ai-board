import { err, type Result } from '../../../shared/result.js';
import type { CommitMessage, DataStore } from '../../../infrastructure/data-store.js';
import type { CardWriteFailure } from '../../errors/card-errors.js';
import { CardWriteRefusedError } from '../../repositories/file-card.repository.js';

// ============================================================
// 書き込みの 1 操作 — カードの書き込みを `DataStore.transact` の中で走らせる
// ============================================================

/**
 * `op` を書き込みの 1 操作（`DataStore.transact`）の中で走らせる。カードへの書き込みは、どれもここを通す。
 *
 * `op` には、書く前の検査から usecase までを入れる。push が拒否されると、`transact` が取り直した最新の状態で
 * `op` を頭から呼び直すので、検査は必ず最新のカードに対して行われる（ADR 0010）。
 * そのため `op` は標準出力にも標準エラーにも書かない。拒むときは Err を返す（`transact` が書きかけを捨て、コミットしない）。
 *
 * 判断の書き換えなど、リポジトリの拒否は `CardWriteRefusedError` の例外で届くので、`CardWriteRefused` の Err に直す。
 * `transact` は同じプロセスの中で 1 列に並ぶので、`op` の中からこれを呼ぶと自分を待って止まる。
 */
export function transactCardWrite<T, E>(
  store: Pick<DataStore, 'transact'>,
  message: CommitMessage<T>,
  op: () => Promise<Result<T, E>>
): Promise<Result<T, E | CardWriteFailure>> {
  return store.transact<T, E | CardWriteFailure>(message, async () => {
    try {
      return await op();
    } catch (error) {
      if (error instanceof CardWriteRefusedError) {
        return err({ type: 'CardWriteRefused', reason: error.reason.type });
      }
      throw error;
    }
  });
}
