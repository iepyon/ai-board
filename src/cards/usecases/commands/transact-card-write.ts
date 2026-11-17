import { err, type Result } from '../../../shared/result.js';
import type { DocumentStore, TransactLabel } from '../../../infrastructure/document-store.js';
import type { CardWriteFailure } from '../../errors/card-errors.js';
import { CardWriteRefusedError } from '../../repositories/doc-card.repository.js';

// ============================================================
// 書き込みの 1 操作 — カードの書き込みを `DocumentStore.transact` の中で走らせる
// ============================================================

/**
 * `op` を書き込みの 1 操作（`DocumentStore.transact`）の中で走らせる。カードへの書き込みは、どれもここを通す。
 *
 * `op` には、書く前の検査から usecase までを入れる。`transact` はロックを取って写しを読み直してから `op` を走らせるので、
 * 検査は手元の最新のカードに対して行われる。置き場所への送り出しで改訂がぶつかったら、取り込み直して頭からやり直す（board-store）。
 * `op` は標準出力にも標準エラーにも書かない。拒むときは Err を返す（`transact` が書きかけを捨て、送る箱に積まない）。
 *
 * 判断の書き換えなど、リポジトリの拒否は `CardWriteRefusedError` の例外で届くので、`CardWriteRefused` の Err に直す。
 * `transact` は同じプロセスの中で 1 列に並ぶので、`op` の中からこれを呼ぶと自分を待って止まる。
 */
export function transactCardWrite<T, E>(
  store: Pick<DocumentStore, 'transact'>,
  message: TransactLabel<T>,
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
