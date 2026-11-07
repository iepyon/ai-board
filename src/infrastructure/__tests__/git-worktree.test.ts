import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { locateWorktree } from '../git-worktree.js';

let base: string;

beforeEach(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-worktree-')));
});

afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true });
});

/** `git worktree add` と同じ形のファイルを作る。戻り値はワークツリーのルート */
async function makeLinkedWorktree(mainRoot: string, name: string): Promise<string> {
  const gitDir = path.join(mainRoot, '.git', 'worktrees', name);
  const tree = path.join(mainRoot, '.claude', 'worktrees', name);
  await fs.mkdir(gitDir, { recursive: true });
  await fs.mkdir(tree, { recursive: true });
  await fs.writeFile(path.join(gitDir, 'commondir'), '../..\n');
  await fs.writeFile(path.join(tree, '.git'), `gitdir: ${gitDir}\n`);
  return tree;
}

describe('locateWorktree', () => {
  it('リンクされたワークツリーなら、メインのチェックアウトを返す', async () => {
    const main = path.join(base, 'repo');
    const tree = await makeLinkedWorktree(main, 'feature');

    expect(locateWorktree(tree)).toEqual({ kind: 'linked', mainRoot: main });
  });

  it('gitdir が相対パスでも解決する', async () => {
    const main = path.join(base, 'repo');
    const tree = await makeLinkedWorktree(main, 'feature');
    await fs.writeFile(path.join(tree, '.git'), 'gitdir: ../../../.git/worktrees/feature\n');

    expect(locateWorktree(tree)).toEqual({ kind: 'linked', mainRoot: main });
  });

  it('.git がディレクトリならメインのチェックアウトとして扱う', async () => {
    await fs.mkdir(path.join(base, '.git'));

    expect(locateWorktree(base)).toEqual({ kind: 'standalone' });
  });

  it('git でないディレクトリはそのまま', () => {
    expect(locateWorktree(base)).toEqual({ kind: 'standalone' });
  });

  it('commondir の無い gitdir（サブモジュール）は独立したリポジトリとして扱う', async () => {
    const modules = path.join(base, '.git', 'modules', 'sub');
    const sub = path.join(base, 'sub');
    await fs.mkdir(modules, { recursive: true });
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, '.git'), `gitdir: ${modules}\n`);

    expect(locateWorktree(sub)).toEqual({ kind: 'standalone' });
  });

  it('gitdir の無い .git ファイルは読み解けないとして理由を返す', async () => {
    await fs.writeFile(path.join(base, '.git'), 'garbage\n');

    expect(locateWorktree(base)).toEqual({
      kind: 'unresolved',
      reason: expect.stringContaining('gitdir'),
    });
  });

  it('メインがベアリポジトリなら読み解けないとして理由を返す', async () => {
    const bare = path.join(base, 'repo.git');
    const gitDir = path.join(bare, 'worktrees', 'feature');
    const tree = path.join(base, 'feature');
    await fs.mkdir(gitDir, { recursive: true });
    await fs.mkdir(tree);
    await fs.writeFile(path.join(gitDir, 'commondir'), '../..\n');
    await fs.writeFile(path.join(tree, '.git'), `gitdir: ${gitDir}\n`);

    expect(locateWorktree(tree)).toEqual({
      kind: 'unresolved',
      reason: expect.stringContaining('ベアリポジトリ'),
    });
  });
});
