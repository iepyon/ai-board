import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { err, ok } from '../../shared/result.js';
import { createCliRunner } from '../cli-runner.js';
import { fetchMainHead, isRemoteName, STORE_REF } from '../git-main-head.js';

// ============================================================
// main の先頭の fetch — マージ済みの計画を読む起点
// ============================================================

let root: string;
let bare: string;
let repo: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function fetchHead(remote: string) {
  return fetchMainHead({
    runner: createCliRunner({ timeoutMs: 20_000 }),
    repoDir: repo,
    remote,
    branch: 'main',
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-main-head-'));
  bare = path.join(root, 'remote.git');
  repo = path.join(root, 'repo');
  fs.mkdirSync(bare);
  git(bare, 'init', '--quiet', '--bare', '--initial-branch=main');
  fs.mkdirSync(repo);
  git(repo, 'init', '--quiet', '--initial-branch=work');
  git(repo, 'config', 'user.name', 'テスト');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('fetchMainHead', () => {
  it('main の先頭を専用の参照に取り、作業ツリーとブランチには触らない', async () => {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '--quiet', '-m', 'a');
    git(repo, 'push', '--quiet', bare, 'work:main');
    const pushed = git(repo, 'rev-parse', 'HEAD').trim();
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b');

    expect(await fetchHead(bare)).toEqual(ok(pushed));
    expect(git(repo, 'rev-parse', STORE_REF).trim()).toBe(pushed);
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('work');
    expect(fs.readFileSync(path.join(repo, 'b.txt'), 'utf-8')).toBe('b');
  });

  it('main がまだ無ければ null', async () => {
    expect(await fetchHead(bare)).toEqual(ok(null));
  });

  it('リモートの名前が無ければ StoreRemoteMissing', async () => {
    expect(await fetchHead('nowhere')).toEqual(
      err({ type: 'StoreRemoteMissing', remote: 'nowhere' })
    );
  });

  it('届かなければ StoreGitFailed', async () => {
    const result = await fetchHead(path.join(root, 'missing.git'));
    expect(!result.ok && result.error.type).toBe('StoreGitFailed');
  });
});

describe('isRemoteName', () => {
  it('名前だけを通し、パスや URL は通さない', () => {
    expect(isRemoteName('origin')).toBe(true);
    expect(isRemoteName('/tmp/store.git')).toBe(false);
    expect(isRemoteName('../store.git')).toBe(false);
    expect(isRemoteName('https://example.invalid/a.git')).toBe(false);
  });
});
