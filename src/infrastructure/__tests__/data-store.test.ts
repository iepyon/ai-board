import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCliRunner, type CliRunner } from '../cli-runner.js';
import {
  createDataStore,
  DATA_BRANCH,
  LOCK_FILE,
  type DataStore,
  type DataStoreOptions,
} from '../data-store.js';
import { err, ok } from '../../shared/result.js';

// ============================================================
// 一時ディレクトリの bare リポジトリを origin にして、本物の git で確かめる
// ============================================================

let tmp: string;
let origin: string;
const runner = createCliRunner({ timeoutMs: 30_000 });

// 本物の git を何度も走らせるので、既定の 5 秒では遅い CI で足りないことがある
vi.setConfig({ testTimeout: 30_000 });

/** 空のリポジトリを clone したときの警告などで、テストの出力を汚さない */
function sh(args: readonly string[]): string {
  return execFileSync('git', [...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function git(cwd: string, ...args: string[]): string {
  return sh(['-C', cwd, ...args]).trim();
}

/**
 * データ用ブランチを origin に用意した clone を、`parent` の下に作る。
 *
 * clone ごとに親を分ける。ロックはデータのワークツリーの親に置かれるので、同じ親だと 2 つの clone が
 * ロックで直列になり、push の拒否の道を通らない。
 */
function cloneData(parent: string): string {
  fs.mkdirSync(parent, { recursive: true });
  const dir = path.join(parent, 'data');
  sh(['clone', '--quiet', '--branch', DATA_BRANCH, origin, dir]);
  return dir;
}

function store(dataDir: string, overrides: Partial<DataStoreOptions> = {}): DataStore {
  return createDataStore({ dataDir, runner, lockPollMs: 10, ...overrides });
}

function originLog(): string[] {
  return git(origin, 'log', '--format=%s', DATA_BRANCH).split('\n');
}

function write(dataDir: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dataDir, file)), { recursive: true });
  fs.writeFileSync(path.join(dataDir, file), content);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-data-store-'));

  // 利用者の git の設定（署名など）に左右されないよう、空の設定と名前を与える
  const globalConfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_AUTHOR_NAME', 'ai-board');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'ai-board@example.com');
  vi.stubEnv('GIT_COMMITTER_NAME', 'ai-board');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'ai-board@example.com');

  origin = path.join(tmp, 'origin.git');
  sh(['init', '--quiet', '--bare', origin]);

  const seed = path.join(tmp, 'seed');
  sh(['clone', '--quiet', origin, seed]);
  git(seed, 'checkout', '--quiet', '--orphan', DATA_BRANCH);
  write(seed, 'ai-board-data.yaml', 'version: 1\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '--quiet', '-m', 'data: 始める');
  git(seed, 'push', '--quiet', 'origin', `HEAD:refs/heads/${DATA_BRANCH}`);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('transact', () => {
  it('op が書いたファイルを 1 コミットにして origin へ push する', async () => {
    const dataDir = cloneData(path.join(tmp, 'a'));

    const result = await store(dataDir).transact('data: x を足す', async (dir) => {
      write(dir, 'cards/x/card.md', 'x\n');
      return ok('written');
    });

    expect(result).toEqual(ok('written'));
    expect(originLog()).toEqual(['data: x を足す', 'data: 始める']);
    expect(git(dataDir, 'status', '--porcelain')).toBe('');
  });

  it('メッセージを op の結果から作れる', async () => {
    const dataDir = cloneData(path.join(tmp, 'a'));

    await store(dataDir).transact(
      (id: string) => `data: ${id} を足す`,
      async (dir) => {
        write(dir, 'cards/y/card.md', 'y\n');
        return ok('y');
      }
    );

    expect(originLog()[0]).toBe('data: y を足す');
  });

  it('検査で拒めば、書きかけのファイルを捨ててコミットしない', async () => {
    const dataDir = cloneData(path.join(tmp, 'a'));

    const result = await store(dataDir).transact('data: 拒む', async (dir) => {
      write(dir, 'cards/x/card.md', 'x\n');
      write(dir, 'ai-board-data.yaml', 'version: 9\n');
      return err({ type: 'Refused' as const });
    });

    expect(result).toEqual(err({ type: 'Refused' }));
    expect(originLog()).toEqual(['data: 始める']);
    expect(git(dataDir, 'log', '--format=%s')).toBe('data: 始める');
    expect(git(dataDir, 'status', '--porcelain')).toBe('');
  });

  it('op が例外を投げても、書きかけのファイルを捨てて例外を伝える', async () => {
    const dataDir = cloneData(path.join(tmp, 'a'));

    await expect(
      store(dataDir).transact('data: 投げる', async (dir) => {
        write(dir, 'cards/x/card.md', 'x\n');
        throw new Error('壊れた');
      })
    ).rejects.toThrow('壊れた');

    expect(git(dataDir, 'status', '--porcelain')).toBe('');
    expect(fs.existsSync(path.join(path.dirname(dataDir), LOCK_FILE))).toBe(false);
  });

  it('何も書かなければコミットしない', async () => {
    const dataDir = cloneData(path.join(tmp, 'a'));

    const result = await store(dataDir).transact('data: 何もしない', async () => ok(1));

    expect(result).toEqual(ok(1));
    expect(originLog()).toEqual(['data: 始める']);
  });

  it('書く前に origin の最新へ取り直し、手元に残った変更を捨てる', async () => {
    const a = cloneData(path.join(tmp, 'a'));
    const b = cloneData(path.join(tmp, 'b'));
    await store(b).transact('data: b が書く', async (dir) => {
      write(dir, 'cards/b/card.md', 'b\n');
      return ok(undefined);
    });
    write(a, 'stray.txt', '手元にだけある\n');

    let seen: string[] = [];
    await store(a).transact('data: a が読む', async (dir) => {
      seen = fs.readdirSync(path.join(dir, 'cards'));
      return ok(undefined);
    });

    expect(seen).toEqual(['b']);
    expect(fs.existsSync(path.join(a, 'stray.txt'))).toBe(false);
  });

  it('2 つの clone から同時に書くと、拒否された側が取り直して op を頭からやり直す', async () => {
    const a = cloneData(path.join(tmp, 'a'));
    const b = cloneData(path.join(tmp, 'b'));
    const storeB = store(b);
    let calls = 0;
    const seenByA: string[][] = [];

    const result = await store(a).transact('data: a が書く', async (dir) => {
      calls++;
      seenByA.push(
        fs.existsSync(path.join(dir, 'cards')) ? fs.readdirSync(path.join(dir, 'cards')) : []
      );
      if (calls === 1) {
        // a が取り直した後、push する前に b が先に push する
        const fromB = await storeB.transact('data: b が書く', async (bDir) => {
          write(bDir, 'cards/b/card.md', 'b\n');
          return ok(undefined);
        });
        expect(fromB).toEqual(ok(undefined));
      }
      write(dir, 'cards/a/card.md', 'a\n');
      return ok(calls);
    });

    expect(result).toEqual(ok(2));
    expect(seenByA).toEqual([[], ['b']]);
    expect(originLog()).toEqual(['data: a が書く', 'data: b が書く', 'data: 始める']);
    expect(git(a, 'rev-parse', 'HEAD')).toBe(git(origin, 'rev-parse', DATA_BRANCH));
  });

  it('拒否が上限まで続けば DataStorePushFailed で失敗し、押し出せなかったコミットを残さない', async () => {
    const a = cloneData(path.join(tmp, 'a'));
    const storeB = store(cloneData(path.join(tmp, 'b')));
    let calls = 0;

    const result = await store(a, { maxRetries: 1 }).transact('data: a が書く', async (dir) => {
      calls++;
      await storeB.transact(`data: b が ${calls} 回目に書く`, async (bDir) => {
        write(bDir, `cards/b${calls}/card.md`, 'b\n');
        return ok(undefined);
      });
      write(dir, 'cards/a/card.md', 'a\n');
      return ok(undefined);
    });

    expect(result).toMatchObject(err({ type: 'DataStorePushFailed', attempts: 2 }));
    expect(calls).toBe(2);
    expect(originLog()).not.toContain('data: a が書く');
    expect(git(a, 'log', '--format=%s')).not.toContain('data: a が書く');
  });

  it('origin が動いていないのに push に失敗したら、やり直さずに失敗する', async () => {
    const a = cloneData(path.join(tmp, 'a'));
    // origin への更新を拒むフックで、拒否ではない push の失敗を作る
    const hook = path.join(origin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    let calls = 0;

    const result = await store(a).transact('data: a が書く', async (dir) => {
      calls++;
      write(dir, 'cards/a/card.md', 'a\n');
      return ok(undefined);
    });

    expect(result).toMatchObject(err({ type: 'DataStorePushFailed', attempts: 1 }));
    expect(calls).toBe(1);
  });

  it('fetch できなければ（オフライン）書かずに DataStoreFetchFailed で失敗する', async () => {
    const a = cloneData(path.join(tmp, 'a'));
    git(a, 'remote', 'set-url', 'origin', path.join(tmp, 'missing.git'));
    let calls = 0;

    const result = await store(a).transact('data: a が書く', async () => {
      calls++;
      return ok(undefined);
    });

    expect(result).toMatchObject(err({ type: 'DataStoreFetchFailed' }));
    expect(calls).toBe(0);
  });

  it('origin が無ければ fetch と push を飛ばし、コミットだけする', async () => {
    const dir = path.join(tmp, 'local', 'data');
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '--quiet', '--initial-branch', DATA_BRANCH);
    write(dir, 'ai-board-data.yaml', 'version: 1\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '--quiet', '-m', 'data: 始める');

    const result = await store(dir).transact('data: x を足す', async (d) => {
      write(d, 'cards/x/card.md', 'x\n');
      return ok(undefined);
    });

    expect(result).toEqual(ok(undefined));
    expect(git(dir, 'log', '--format=%s').split('\n')).toEqual(['data: x を足す', 'data: 始める']);
  });

  it('同じ DataStore への同時の呼び出しは、順に並べて両方とも通す', async () => {
    const a = store(cloneData(path.join(tmp, 'a')), { lockTimeoutMs: 100 });

    const results = await Promise.all(
      ['p', 'q'].map((id) =>
        a.transact(`data: ${id} を足す`, async (dir) => {
          write(dir, `cards/${id}/card.md`, `${id}\n`);
          await new Promise((resolve) => setTimeout(resolve, 150));
          return ok(id);
        })
      )
    );

    expect(results).toEqual([ok('p'), ok('q')]);
    expect(originLog()).toEqual(['data: q を足す', 'data: p を足す', 'data: 始める']);
  });
});

describe('ロック', () => {
  it('生きていない pid のロックは取り直す', async () => {
    const dataDir = cloneData(path.join(tmp, 'a'));
    const lockPath = path.join(path.dirname(dataDir), LOCK_FILE);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999_999, token: 'stale', at: '' }));

    const result = await store(dataDir, { isAlive: () => false }).transact(
      'data: x',
      async (dir) => {
        write(dir, 'x.txt', 'x\n');
        return ok(undefined);
      }
    );

    expect(result).toEqual(ok(undefined));
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('生きている持ち主が放さなければ、待つ上限で DataStoreLockTimeout になり、そのロックは消さない', async () => {
    const dataDir = cloneData(path.join(tmp, 'a'));
    const lockPath = path.join(path.dirname(dataDir), LOCK_FILE);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 4242, token: 'other', at: '' }));
    const op = vi.fn(async () => ok(undefined));

    const result = await store(dataDir, { isAlive: () => true, lockTimeoutMs: 50 }).transact(
      'data: x',
      op
    );

    expect(result).toEqual(err({ type: 'DataStoreLockTimeout', lockPath }));
    expect(op).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(lockPath, 'utf-8'))).toMatchObject({ token: 'other' });
  });

  it('中身の読めないロックは書きかけとみなして待つ', async () => {
    const dataDir = cloneData(path.join(tmp, 'a'));
    const lockPath = path.join(path.dirname(dataDir), LOCK_FILE);
    fs.writeFileSync(lockPath, '');

    const result = await store(dataDir, { isAlive: () => false, lockTimeoutMs: 50 }).refresh();

    expect(result).toMatchObject(err({ type: 'DataStoreLockTimeout' }));
  });
});

describe('refresh', () => {
  it('origin の最新へ合わせる', async () => {
    const a = cloneData(path.join(tmp, 'a'));
    const b = cloneData(path.join(tmp, 'b'));
    await store(b).transact('data: b が書く', async (dir) => {
      write(dir, 'cards/b/card.md', 'b\n');
      return ok(undefined);
    });

    const result = await store(a).refresh();

    expect(result).toEqual(ok({ kind: 'fetched' }));
    expect(fs.existsSync(path.join(a, 'cards/b/card.md'))).toBe(true);
  });

  it('fetch できなければ、警告の理由を返して手元の内容のまま読ませる', async () => {
    const a = cloneData(path.join(tmp, 'a'));
    git(a, 'remote', 'set-url', 'origin', path.join(tmp, 'missing.git'));

    const result = await store(a).refresh();

    expect(result).toMatchObject(ok({ kind: 'offline' }));
    expect(fs.existsSync(path.join(a, 'ai-board-data.yaml'))).toBe(true);
  });
});

describe('形の版', () => {
  /** ほかの clone から、origin の ai-board-data.yaml を書き換える（消すなら null） */
  function pushVersionFile(content: string | null): void {
    const other = cloneData(path.join(tmp, 'other'));
    if (content === null) {
      git(other, 'rm', '--quiet', 'ai-board-data.yaml');
    } else {
      write(other, 'ai-board-data.yaml', content);
      git(other, 'add', '-A');
    }
    git(other, 'commit', '--quiet', '-m', 'data: 形の版を変える');
    git(other, 'push', '--quiet', 'origin', `HEAD:refs/heads/${DATA_BRANCH}`);
  }

  it('取り直した版がこの CLI より新しければ、refresh は UnsupportedDataVersion で止まる', async () => {
    const a = cloneData(path.join(tmp, 'a'));
    pushVersionFile('version: 2\n');

    expect(await store(a).refresh()).toEqual(
      err({ type: 'UnsupportedDataVersion', found: 2, supported: 1 })
    );
  });

  it('取り直した版がこの CLI より新しければ、transact は op を走らせずに止まり、何も push しない', async () => {
    const a = cloneData(path.join(tmp, 'a'));
    pushVersionFile('version: 2\n');
    const before = originLog();
    let calls = 0;

    const result = await store(a).transact('data: a が書く', async (dir) => {
      calls++;
      write(dir, 'cards/a/card.md', 'a\n');
      return ok(undefined);
    });

    expect(result).toEqual(err({ type: 'UnsupportedDataVersion', found: 2, supported: 1 }));
    expect(calls).toBe(0);
    expect(originLog()).toEqual(before);
    expect(git(a, 'status', '--porcelain')).toBe('');
  });

  it('版が読めなければ MalformedDataVersion で止まる', async () => {
    const a = cloneData(path.join(tmp, 'a'));
    pushVersionFile('version: two\n');

    expect(await store(a).refresh()).toMatchObject(err({ type: 'MalformedDataVersion' }));
  });

  it('origin に届かなくても、手元の版が新しければ止まる', async () => {
    const a = cloneData(path.join(tmp, 'a'));
    pushVersionFile('version: 2\n');
    git(a, 'fetch', '--quiet', 'origin');
    git(a, 'remote', 'set-url', 'origin', path.join(tmp, 'missing.git'));

    expect(await store(a).refresh()).toEqual(
      err({ type: 'UnsupportedDataVersion', found: 2, supported: 1 })
    );
  });

  it('ai-board-data.yaml が無ければ確かめずに読む', async () => {
    const a = cloneData(path.join(tmp, 'a'));
    pushVersionFile(null);

    expect(await store(a).refresh()).toEqual(ok({ kind: 'fetched' }));
  });
});

describe('データのワークツリーの HEAD', () => {
  /** `main` を checkout し、コミットと追跡していないファイルを持つ、コードの普通の clone */
  function codeClone(): string {
    const dir = path.join(tmp, 'code', 'repo');
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    sh(['clone', '--quiet', origin, dir]);
    git(dir, 'checkout', '--quiet', '-b', 'main');
    write(dir, 'src/app.ts', 'export {};\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '--quiet', '-m', 'feat: 始める');
    write(dir, 'notes.txt', '追跡していない\n');
    return dir;
  }

  /** clone の中身が変わっていないことを確かめるための控え */
  function snapshot(dir: string): Record<string, string> {
    return {
      head: git(dir, 'symbolic-ref', 'HEAD'),
      main: git(dir, 'rev-parse', 'refs/heads/main'),
      status: git(dir, 'status', '--porcelain'),
      app: fs.readFileSync(path.join(dir, 'src/app.ts'), 'utf-8'),
      notes: fs.readFileSync(path.join(dir, 'notes.txt'), 'utf-8'),
    };
  }

  it('main を checkout した clone を指すと、refresh は reset も clean もせずに DataDirWrongBranch で止まる', async () => {
    const dir = codeClone();
    const before = snapshot(dir);

    const result = await store(dir).refresh();

    expect(result).toEqual(
      err({ type: 'DataDirWrongBranch', dataDir: dir, branch: 'refs/heads/main' })
    );
    expect(snapshot(dir)).toEqual(before);
  });

  it('main を checkout した clone を指すと、transact は op を走らせずに止まり、何も push しない', async () => {
    const dir = codeClone();
    const before = snapshot(dir);
    let calls = 0;

    const result = await store(dir).transact('data: 書く', async (d) => {
      calls++;
      write(d, 'cards/x/card.md', 'x\n');
      return ok(undefined);
    });

    expect(result).toEqual(
      err({ type: 'DataDirWrongBranch', dataDir: dir, branch: 'refs/heads/main' })
    );
    expect(calls).toBe(0);
    expect(originLog()).toEqual(['data: 始める']);
    expect(snapshot(dir)).toEqual(before);
  });

  it('origin が無くても、main を checkout した clone なら clean せずに止まる', async () => {
    const dir = codeClone();
    git(dir, 'remote', 'remove', 'origin');
    const before = snapshot(dir);

    const result = await store(dir).refresh();

    expect(result).toMatchObject(err({ type: 'DataDirWrongBranch' }));
    expect(snapshot(dir)).toEqual(before);
  });

  it('HEAD がブランチを指していなければ（detached）止まる', async () => {
    const dir = cloneData(path.join(tmp, 'a'));
    git(dir, 'checkout', '--quiet', '--detach');

    const result = await store(dir).refresh();

    expect(result).toEqual(err({ type: 'DataDirWrongBranch', dataDir: dir, branch: null }));
  });

  it('まだコミットの無いブランチの clone なら、HEAD をデータ用ブランチへ向け直して取り直す', async () => {
    // origin の HEAD はまだ無いブランチを指すので、この clone の HEAD もコミットの無いブランチになる
    const dir = path.join(tmp, 'fresh', 'data');
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    sh(['clone', '--quiet', origin, dir]);
    expect(git(dir, 'symbolic-ref', 'HEAD')).not.toBe(`refs/heads/${DATA_BRANCH}`);

    const result = await store(dir).refresh();

    expect(result).toEqual(ok({ kind: 'fetched' }));
    expect(git(dir, 'symbolic-ref', 'HEAD')).toBe(`refs/heads/${DATA_BRANCH}`);
    expect(fs.existsSync(path.join(dir, 'ai-board-data.yaml'))).toBe(true);
    expect(git(dir, 'for-each-ref', '--format=%(refname)', 'refs/heads')).toBe(
      `refs/heads/${DATA_BRANCH}`
    );
  });
});

describe('prepare', () => {
  function mainRepo(): string {
    const repo = path.join(tmp, 'main');
    sh(['clone', '--quiet', origin, repo]);
    return repo;
  }

  it('データのワークツリーが無ければ、origin のデータ用ブランチからワークツリーを作る', async () => {
    const repo = mainRepo();
    const dataDir = path.join(repo, '.ai-board', 'data');

    const result = await store(dataDir, { repoRoot: repo }).prepare();

    expect(result).toEqual(ok(undefined));
    expect(fs.readFileSync(path.join(dataDir, 'ai-board-data.yaml'), 'utf-8')).toBe('version: 1\n');
    expect(git(dataDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(DATA_BRANCH);
  });

  it('手元に同じ名前のブランチが既にあれば、それをワークツリーにする', async () => {
    const repo = mainRepo();
    git(repo, 'fetch', '--quiet', 'origin', `${DATA_BRANCH}:${DATA_BRANCH}`);
    const dataDir = path.join(repo, '.ai-board', 'data');

    const result = await store(dataDir, { repoRoot: repo }).prepare();

    expect(result).toEqual(ok(undefined));
    expect(git(dataDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(DATA_BRANCH);
  });

  it('人がデータのワークツリーを消しても、登録の残りを片付けて作り直す', async () => {
    const repo = mainRepo();
    const dataDir = path.join(repo, '.ai-board', 'data');
    expect(await store(dataDir, { repoRoot: repo }).prepare()).toEqual(ok(undefined));

    // git にはワークツリーの登録が残る（missing but already registered worktree）
    fs.rmSync(dataDir, { recursive: true, force: true });

    const result = await store(dataDir, { repoRoot: repo }).prepare();

    expect(result).toEqual(ok(undefined));
    expect(fs.readFileSync(path.join(dataDir, 'ai-board-data.yaml'), 'utf-8')).toBe('version: 1\n');
    expect(git(dataDir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(DATA_BRANCH);
  });

  it('origin にデータ用ブランチが無ければ DataBranchMissing', async () => {
    const empty = path.join(tmp, 'empty.git');
    sh(['init', '--quiet', '--bare', empty]);
    const repo = path.join(tmp, 'main');
    sh(['clone', '--quiet', empty, repo]);
    const dataDir = path.join(repo, '.ai-board', 'data');

    const result = await store(dataDir, { repoRoot: repo }).prepare();

    expect(result).toEqual(err({ type: 'DataBranchMissing', dataDir }));
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it('origin の無いリポジトリで手元にもブランチが無ければ DataBranchMissing', async () => {
    const repo = path.join(tmp, 'solo');
    fs.mkdirSync(repo);
    git(repo, 'init', '--quiet');
    const dataDir = path.join(repo, '.ai-board', 'data');

    const result = await store(dataDir, { repoRoot: repo }).prepare();

    expect(result).toEqual(err({ type: 'DataBranchMissing', dataDir }));
  });

  it('作る元のリポジトリを渡されていなければ DataBranchMissing', async () => {
    const dataDir = path.join(tmp, 'nowhere', 'data');

    const result = await store(dataDir).transact('data: x', async () => ok(undefined));

    expect(result).toEqual(err({ type: 'DataBranchMissing', dataDir }));
  });

  it('git のワークツリーでないディレクトリにファイルがあれば、上書きせずに失敗する', async () => {
    const dataDir = path.join(tmp, 'plain', 'data');
    write(dataDir, 'note.txt', 'x\n');

    const result = await store(dataDir, { repoRoot: tmp }).refresh();

    expect(result).toEqual(err({ type: 'DataDirNotRepository', dataDir }));
  });

  it('ls-remote に失敗したら DataStoreFetchFailed', async () => {
    const repo = mainRepo();
    git(repo, 'remote', 'set-url', 'origin', path.join(tmp, 'missing.git'));
    const dataDir = path.join(repo, '.ai-board', 'data');

    const result = await store(dataDir, { repoRoot: repo }).prepare();

    expect(result).toMatchObject(err({ type: 'DataStoreFetchFailed' }));
  });
});

describe('git の呼び出し', () => {
  it('git には引数を配列で渡し、-C でデータのワークツリーを指す', async () => {
    const dataDir = cloneData(path.join(tmp, 'a'));
    const calls: (readonly string[])[] = [];
    const spying: CliRunner = {
      run: (command, args, options) => {
        calls.push([command, ...args]);
        return runner.run(command, args, options);
      },
    };

    await createDataStore({ dataDir, runner: spying }).transact('data: x', async (dir) => {
      write(dir, 'x.txt', 'x\n');
      return ok(undefined);
    });

    expect(
      calls.every((call) => call[0] === 'git' && call[1] === '-C' && call[2] === dataDir)
    ).toBe(true);
    expect(calls).toContainEqual([
      'git',
      '-C',
      dataDir,
      'fetch',
      '--quiet',
      'origin',
      `+refs/heads/${DATA_BRANCH}:refs/remotes/origin/${DATA_BRANCH}`,
    ]);
    expect(calls).toContainEqual([
      'git',
      '-C',
      dataDir,
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      'data: x',
    ]);
  });

  it('git commit が失敗したら、書きかけのファイルを捨ててから DataStoreGitFailed を返す', async () => {
    const dataDir = cloneData(path.join(tmp, 'a'));
    const failingCommit: CliRunner = {
      run: (command, args, options) =>
        args[2] === 'commit'
          ? Promise.resolve(
              err({
                type: 'Failed',
                command: 'git',
                message: '終了コード 128 で失敗した',
                httpStatus: null,
              })
            )
          : runner.run(command, args, options),
    };

    const result = await createDataStore({ dataDir, runner: failingCommit }).transact(
      'data: x',
      async (dir) => {
        write(dir, 'cards/x/card.md', 'x\n');
        write(dir, 'ai-board-data.yaml', 'version: 1\nchanged: true\n');
        return ok(undefined);
      }
    );

    expect(result).toMatchObject(err({ type: 'DataStoreGitFailed', step: 'commit' }));
    expect(git(dataDir, 'status', '--porcelain')).toBe('');
    expect(fs.existsSync(path.join(dataDir, 'cards', 'x', 'card.md'))).toBe(false);
    expect(fs.readFileSync(path.join(dataDir, 'ai-board-data.yaml'), 'utf-8')).toBe('version: 1\n');
    expect(originLog()).toEqual(['data: 始める']);
  });

  it('git の失敗は DataStoreGitFailed にする', async () => {
    const dataDir = cloneData(path.join(tmp, 'a'));
    const failing: CliRunner = {
      run: async () =>
        err({
          type: 'Failed',
          command: 'git',
          message: '終了コード 128 で失敗した',
          httpStatus: null,
        }),
    };

    const result = await createDataStore({ dataDir, runner: failing }).refresh();

    expect(result).toEqual(
      err({
        type: 'DataStoreGitFailed',
        step: 'remote',
        message: 'git の終了コード 128 で失敗した',
      })
    );
  });
});
