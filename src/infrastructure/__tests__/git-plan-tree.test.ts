import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCliRunner } from '../cli-runner.js';
import type { StoreConfig } from '../config.js';
import { PLAN_REF, resolvePlanCommit } from '../git-plan-tree.js';

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

/** コードのリポジトリ（origin の main に 1 コミットある）を作る */
function codeRepo(): { repo: string; head: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-plan-tree-'));
  dirs.push(base);
  const bare = path.join(base, 'origin.git');
  git(base, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
  const repo = path.join(base, 'work');
  git(base, 'init', '--quiet', '--initial-branch=main', repo);
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  git(repo, 'remote', 'add', 'origin', bare);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'init');
  git(repo, 'push', '--quiet', 'origin', 'main');
  return { repo, head: git(repo, 'rev-parse', 'HEAD').trim() };
}

function storeConfig(overrides: Partial<StoreConfig>): StoreConfig {
  return {
    remote: 'origin',
    branch: 'ai-board-data',
    planBranch: 'main',
    branchRemote: 'origin',
    ...overrides,
  };
}

describe('resolvePlanCommit', () => {
  it('置き場所がコードの main と同じブランチなら、置き場所の先頭をそのまま返す（fetch しない）', async () => {
    const { repo } = codeRepo();
    const commit = await resolvePlanCommit({
      runner: createCliRunner(),
      repoDir: repo,
      store: storeConfig({ branch: 'main' }),
      storeHead: 'abc123',
    });

    expect(commit).toBe('abc123');
    expect(() => git(repo, 'rev-parse', '--verify', PLAN_REF)).toThrow();
  });

  it('置き場所が専用のブランチなら、コードのリポジトリの main の先頭を fetch して返す', async () => {
    const { repo, head } = codeRepo();
    const commit = await resolvePlanCommit({
      runner: createCliRunner(),
      repoDir: repo,
      store: storeConfig({}),
      storeHead: 'ignored-data-head',
    });

    expect(commit).toBe(head);
    expect(git(repo, 'rev-parse', PLAN_REF).trim()).toBe(head);
  });

  it('取れないときは警告して null を返す（ボード全体を止めない）', async () => {
    const { repo } = codeRepo();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const commit = await resolvePlanCommit({
      runner: createCliRunner(),
      repoDir: repo,
      store: storeConfig({ planBranch: 'no-such-branch' }),
      storeHead: null,
    });

    expect(commit).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });
});
