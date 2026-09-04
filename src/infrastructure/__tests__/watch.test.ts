import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FSWatcher } from 'chokidar';
import { startWatching } from '../watch.js';

let root: string;
let watcher: FSWatcher | null = null;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-watch-'));
});

afterEach(async () => {
  await watcher?.close();
  watcher = null;
  await fs.rm(root, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 変更が通知されるまで待つ。タイムアウトしたら false */
async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return false;
}

describe('startWatching', () => {
  it('ファイルの変更を通知する', async () => {
    const onChange = vi.fn();
    watcher = startWatching({ paths: [root], onChange, debounceMs: 50 });
    await sleep(300);

    await fs.writeFile(path.join(root, 'card.md'), '内容', 'utf-8');

    expect(await waitFor(() => onChange.mock.calls.length > 0)).toBe(true);
  });

  it('短時間に連続した変更を 1 回にまとめる', async () => {
    const onChange = vi.fn();
    watcher = startWatching({ paths: [root], onChange, debounceMs: 200 });
    await sleep(300);

    for (let i = 0; i < 5; i += 1) {
      await fs.writeFile(path.join(root, `card-${i}.md`), '内容', 'utf-8');
    }

    expect(await waitFor(() => onChange.mock.calls.length > 0)).toBe(true);
    await sleep(400);

    // デバウンスにより、5 ファイル分のイベントが 1〜2 回に収まる
    expect(onChange.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('存在しないディレクトリを渡してもエラーにしない', () => {
    const onChange = vi.fn();

    expect(() => {
      watcher = startWatching({
        paths: [path.join(root, 'does-not-exist')],
        onChange,
        debounceMs: 50,
      });
    }).not.toThrow();
  });
});
