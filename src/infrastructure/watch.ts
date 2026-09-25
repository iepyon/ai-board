import chokidar, { type FSWatcher } from 'chokidar';

// ============================================================
// ファイル監視
// ============================================================

const DEBOUNCE_MS = 150;

export interface WatchOptions {
  readonly paths: readonly string[];
  readonly onChange: () => void;
  readonly debounceMs?: number;
}

/**
 * `.ai-board/` を監視して変更を通知する（カードと計画ファイルの両方）。
 *
 * エディタで直接カードを書き換えたときもボードへ即座に反映させるため。
 * 保存が複数イベントに分かれることがあるのでデバウンスする。
 */
export function startWatching({
  paths,
  onChange,
  debounceMs = DEBOUNCE_MS,
}: WatchOptions): FSWatcher {
  const watcher = chokidar.watch([...paths], {
    ignoreInitial: true,
    // エディタの一時ファイルで無駄に発火させない
    ignored: (target) => /(^|[/\\])\..*\.swp$|~$|\.tmp$/.test(target),
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
