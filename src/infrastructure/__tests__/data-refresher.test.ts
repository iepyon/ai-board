import { describe, it, expect, afterEach, vi } from 'vitest';
import { err, ok, type Result } from '../../shared/result.js';
import type { DataStore, DataStoreError, RefreshOutcome } from '../data-store.js';
import { startDataRefresher, type DataRefresher } from '../data-refresher.js';

// ============================================================
// データ用ブランチの定期の取り直し
// ============================================================

type RefreshResult = Result<RefreshOutcome, DataStoreError>;

/** 呼ばれるたびに `results` を順に返す偽の store。尽きたら fetched を返す */
function fakeStore(results: RefreshResult[] = []): Pick<DataStore, 'refresh'> & {
  readonly refresh: ReturnType<typeof vi.fn>;
} {
  return {
    refresh: vi.fn(async () => results.shift() ?? ok({ kind: 'fetched' } as const)),
  };
}

let refresher: DataRefresher | null = null;

afterEach(async () => {
  await refresher?.stop();
  refresher = null;
  vi.useRealTimers();
});

describe('startDataRefresher', () => {
  it('間隔ごとに取り直す', async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    refresher = startDataRefresher({ store, intervalMs: 60_000 });

    expect(store.refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.refresh).toHaveBeenCalledTimes(2);
  });

  it('前の取り直しが終わっていなければ、新しく走らせない', async () => {
    let release: () => void = () => undefined;
    const store = {
      refresh: vi.fn(
        () =>
          new Promise<RefreshResult>((resolve) => {
            release = () => resolve(ok({ kind: 'fetched' }));
          })
      ),
    };
    refresher = startDataRefresher({ store, intervalMs: 60_000 });

    const first = refresher.tick();
    const second = refresher.tick();
    expect(store.refresh).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second]);

    // 終わった後は、また走らせる
    const third = refresher.tick();
    expect(store.refresh).toHaveBeenCalledTimes(2);
    release();
    await third;
  });

  it('オフラインは、続く間 1 回だけ知らせる', async () => {
    const offline = ok({ kind: 'offline', reason: 'network' } as const);
    const store = fakeStore([offline, offline, ok({ kind: 'fetched' }), offline]);
    const onProblem = vi.fn();
    refresher = startDataRefresher({ store, intervalMs: 60_000, onProblem });

    for (let i = 0; i < 4; i++) await refresher.tick();

    expect(onProblem.mock.calls).toEqual([
      [{ kind: 'offline', reason: 'network' }],
      [{ kind: 'offline', reason: 'network' }],
    ]);
  });

  it('取り直しの失敗と例外を、外へ投げずに知らせる', async () => {
    const error: DataStoreError = { type: 'DataStoreLockTimeout', lockPath: '/tmp/data.lock' };
    const thrown = new Error('boom');
    const store = {
      refresh: vi
        .fn<() => Promise<RefreshResult>>()
        .mockResolvedValueOnce(err(error))
        .mockRejectedValueOnce(thrown),
    };
    const onProblem = vi.fn();
    refresher = startDataRefresher({ store, intervalMs: 60_000, onProblem });

    await expect(refresher.tick()).resolves.toBeUndefined();
    await expect(refresher.tick()).resolves.toBeUndefined();

    expect(onProblem.mock.calls).toEqual([
      [{ kind: 'failed', error }],
      [{ kind: 'threw', error: thrown }],
    ]);
  });

  it('止めた後は取り直さず、走っている取り直しを待つ', async () => {
    vi.useFakeTimers();
    let finished = false;
    const store = {
      refresh: vi.fn(async (): Promise<RefreshResult> => {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        finished = true;
        return ok({ kind: 'fetched' });
      }),
    };
    refresher = startDataRefresher({ store, intervalMs: 60_000 });

    await vi.advanceTimersByTimeAsync(60_000);
    const stopped = refresher.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    await stopped;
    expect(finished).toBe(true);

    await vi.advanceTimersByTimeAsync(180_000);
    expect(store.refresh).toHaveBeenCalledTimes(1);
  });
});
