import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { err, ok, type Result } from '../shared/result.js';

// ============================================================
// ロックファイル — 手元の複数のプロセスの書き込みを 1 列にする
// ============================================================

/** ロックを待つ上限 */
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/** ロックが空くのを確かめ直す間隔 */
export const DEFAULT_LOCK_POLL_MS = 50;

export interface LockOptions {
  readonly timeoutMs: number;
  readonly pollMs: number;
  /** ロックの持ち主が生きているか。テストで差し替える */
  readonly isAlive: (pid: number) => boolean;
}

/** 待ち切れなかった */
export interface LockTimeout {
  readonly type: 'LockTimeout';
  readonly lockPath: string;
}

interface LockContent {
  readonly pid: number;
  readonly token: string;
  readonly at: string;
}

export const defaultLockOptions: LockOptions = {
  timeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
  pollMs: DEFAULT_LOCK_POLL_MS,
  isAlive: isProcessAlive,
};

/**
 * ロックを取って `op` を走らせ、終わったら（例外でも）放す。
 *
 * ロックファイルは排他作成で取り、中に pid と時刻と札を書く。
 * 持ち主の pid が死んでいれば（落ちたプロセスの残骸）、消して取り直す。
 * 中身が読めないものは書きかけの可能性があるので、生きているものとして待つ。
 */
export async function withFileLock<T>(
  lockPath: string,
  options: LockOptions,
  op: () => Promise<T>
): Promise<Result<T, LockTimeout>> {
  const token = await acquireLock(lockPath, options);
  if (token === null) return err({ type: 'LockTimeout', lockPath });
  try {
    return ok(await op());
  } finally {
    releaseLock(lockPath, token);
  }
}

async function acquireLock(lockPath: string, options: LockOptions): Promise<string | null> {
  const token = randomUUID();
  const content: LockContent = { pid: process.pid, token, at: new Date().toISOString() };
  const deadline = Date.now() + options.timeoutMs;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      fs.writeFileSync(lockPath, `${JSON.stringify(content)}\n`, { flag: 'wx' });
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const holder = readLock(lockPath);
    if (holder !== null && !options.isAlive(holder.pid)) {
      fs.rmSync(lockPath, { force: true });
      continue;
    }

    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs));
  }
}

/** 中の札が自分のときだけ消す。ほかのプロセスが死んだロックとして取り直したものは消さない */
function releaseLock(lockPath: string, token: string): void {
  if (readLock(lockPath)?.token !== token) return;
  fs.rmSync(lockPath, { force: true });
}

function readLock(lockPath: string): LockContent | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'pid' in parsed &&
      typeof parsed.pid === 'number' &&
      'token' in parsed &&
      typeof parsed.token === 'string'
    ) {
      return { pid: parsed.pid, token: parsed.token, at: 'at' in parsed ? String(parsed.at) : '' };
    }
    return null;
  } catch {
    return null;
  }
}

/** シグナル 0 は届くかだけを確かめる。EPERM は別のユーザのプロセスが生きていることを示す */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
