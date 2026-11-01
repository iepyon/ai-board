import { isErr } from '../shared/result.js';
import type { DataStore, DataStoreError } from './data-store.js';

// ============================================================
// データ用ブランチの定期の取り直し
// ============================================================

/** 取り直しで起きたこと。サーバはこれを警告として出す */
export type RefreshProblem =
  /** fetch に失敗した（オフラインなど）。続く間は 1 回だけ知らせる */
  | { readonly kind: 'offline'; readonly reason: string }
  /** 取り直しそのものに失敗した（ロックの待ち切れ、git の失敗など） */
  | { readonly kind: 'failed'; readonly error: DataStoreError }
  /** 想定していない例外 */
  | { readonly kind: 'threw'; readonly error: unknown };

export interface DataRefresherOptions {
  /**
   * 取り直す `DataStore`。サーバの書き込みと同じインスタンスを渡す。
   *
   * 同じプロセスの中の操作は、インスタンスの中で 1 列に並ぶ。別のインスタンスを作ると、
   * 生きている自分の pid のロックを待ち合って、待つ上限で失敗する。
   */
  readonly store: Pick<DataStore, 'refresh'>;
  readonly intervalMs: number;
  readonly onProblem?: (problem: RefreshProblem) => void;
}

export interface DataRefresher {
  /** 1 回取り直す。前の取り直しが終わっていなければ、それを待つだけで新しく走らせない */
  tick(): Promise<void>;
  /** タイマーを止め、走っている取り直しが終わるのを待つ */
  stop(): Promise<void>;
}

/**
 * データ用ブランチを、決まった間隔で取り直す。
 *
 * クラウドのセッションなど、ほかの場所からの書き込みを拾うため。取り直しで変わったファイルは、
 * データのワークツリーのファイル監視が拾って画面へ知らせる。手元にしか無い変更は持たない前提なので、
 * 取り直しで失うものは無い。
 *
 * 失敗しても例外を外へ出さない（`setInterval` から漏れた reject はプロセスを落とす）。
 */
export function startDataRefresher({
  store,
  intervalMs,
  onProblem = () => undefined,
}: DataRefresherOptions): DataRefresher {
  let running: Promise<void> | null = null;
  let offline = false;

  const run = async (): Promise<void> => {
    try {
      const refreshed = await store.refresh();
      if (isErr(refreshed)) {
        onProblem({ kind: 'failed', error: refreshed.error });
        return;
      }

      if (refreshed.value.kind === 'offline') {
        if (!offline) onProblem({ kind: 'offline', reason: refreshed.value.reason });
        offline = true;
        return;
      }
      offline = false;
    } catch (error) {
      onProblem({ kind: 'threw', error });
    }
  };

  const tick = (): Promise<void> => {
    running ??= run().finally(() => {
      running = null;
    });
    return running;
  };

  const timer = setInterval(() => void tick(), intervalMs);
  // 取り直しだけでプロセスを生かし続けない
  timer.unref?.();

  return {
    tick,
    stop: async () => {
      clearInterval(timer);
      await running;
    },
  };
}
