import * as path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';

// ============================================================
// ファイル監視
// ============================================================

const DEBOUNCE_MS = 150;

export interface WatchOptions {
  readonly paths: readonly string[];
  readonly onChange: () => void;
  /**
   * 見ないファイルやディレクトリ（その下も含む）。
   *
   * 書き込みのたびに作っては消すロックや、ボードの表示に効かない控えを渡す。拾うと、変化の無い通知が出続ける。
   */
  readonly ignoredPaths?: readonly string[];
  readonly debounceMs?: number;
}

/**
 * 計画ファイルとデータのワークツリーを監視して変更を通知する。
 *
 * エージェントが計画ファイルを書いたとき、CLI がカードを書いたとき、取り直しでほかの場所の書き込みが
 * 届いたときに、ボードへ即座に反映させるため。保存が複数イベントに分かれることがあるのでデバウンスする。
 *
 * git の管理のファイル（`.git` の下、ワークツリーでは `.git` のファイル）は見ない。
 * fetch のたびに書かれ、カードの変化が無くても発火するからである。カードの変化は、取り直しの
 * `reset --hard` がワークツリーのファイルを書き換えたときに拾える。
 */
export function startWatching({
  paths,
  onChange,
  ignoredPaths = [],
  debounceMs = DEBOUNCE_MS,
}: WatchOptions): FSWatcher {
  const ignoredRoots = ignoredPaths.map((target) => path.resolve(target));
  const isIgnoredPath = (target: string): boolean => {
    const resolved = path.resolve(target);
    return ignoredRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  };

  const watcher = chokidar.watch([...paths], {
    ignoreInitial: true,
    // エディタの一時ファイルと git の管理のファイルで無駄に発火させない
    ignored: (target) =>
      /(^|[/\\])\..*\.swp$|~$|\.tmp$/.test(target) ||
      /(^|[/\\])\.git([/\\]|$)/.test(target) ||
      isIgnoredPath(target),
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
  });

  let timer: NodeJS.Timeout | null = null;
  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, debounceMs);
    timer.unref?.();
  };

  watcher.on('all', schedule);
  watcher.on('error', (error) => {
    console.warn('[ai-board] ファイル監視でエラーが発生しました:', error);
  });

  return watcher;
}
