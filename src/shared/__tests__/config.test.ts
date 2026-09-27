import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, resolvePaths } from '../config.js';

let root: string;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-config-')));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeConfig(yaml: string): Promise<void> {
  const dir = path.join(root, '.ai-board');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'config.yaml'), yaml, 'utf-8');
}

const githubYaml = 'github:\n  repository: iepyon/ai-board\n';

describe('resolvePaths', () => {
  it('プロジェクトルートから各ディレクトリを導く', () => {
    const paths = resolvePaths(root);

    expect(paths.boardDir).toBe(path.join(root, '.ai-board'));
    expect(paths.cardsDir).toBe(path.join(root, '.ai-board', 'cards'));
    expect(paths.plansDir).toBe(path.join(root, '.ai-board', 'plans'));
  });

  it('相対パスを絶対パスにする', () => {
    expect(path.isAbsolute(resolvePaths('.').root)).toBe(true);
  });
});

describe('loadConfig', () => {
  it('設定ファイルが無ければ連携を無効にする', () => {
    expect(loadConfig(root).forge).toBeNull();
  });

  it('取得先のセクションが無ければ無効にする', async () => {
    await writeConfig('# 空の設定\n');

    expect(loadConfig(root).forge).toBeNull();
  });

  it('github が書かれていれば owner と repo に分けて有効にする', async () => {
    await writeConfig(githubYaml);

    expect(loadConfig(root).forge).toEqual({
      kind: 'github',
      owner: 'iepyon',
      repo: 'ai-board',
    });
  });

  it('設定ファイルにトークンを書いても読み取らない', async () => {
    await writeConfig(`${githubYaml}  token: written-in-file\n`);

    const forge = loadConfig(root).forge;

    expect(forge).not.toBeNull();
    expect(JSON.stringify(forge)).not.toContain('written-in-file');
  });

  it('環境変数にトークンがあっても設定には現れない', async () => {
    await writeConfig(githubYaml);
    process.env.AI_BOARD_GITHUB_TOKEN = 'secret';

    try {
      expect(JSON.stringify(loadConfig(root).forge)).not.toContain('secret');
    } finally {
      delete process.env.AI_BOARD_GITHUB_TOKEN;
    }
  });

  it('gitlab のセクションは読まない', async () => {
    await writeConfig('gitlab:\n  url: http://localhost:8929\n  projectId: 3\n');

    expect(loadConfig(root).forge).toBeNull();
  });

  it('repository が owner/repo の形でなければエラーにする', async () => {
    await writeConfig('github:\n  repository: ai-board\n');

    expect(() => loadConfig(root)).toThrow(/owner\/repo/);
  });

  it('不正な設定はエラーにする', async () => {
    await writeConfig('github:\n  repository: 3\n');

    expect(() => loadConfig(root)).toThrow(/config.yaml/);
  });
});

// ============================================================
// ワークツリーでの置き場所
// ============================================================

/** `git worktree add` と同じ形のファイルを `root` の下に作り、ワークツリーのルートを返す */
async function makeLinkedWorktree(name: string): Promise<string> {
  const gitDir = path.join(root, '.git', 'worktrees', name);
  const tree = path.join(root, '.claude', 'worktrees', name);
  await fs.mkdir(gitDir, { recursive: true });
  await fs.mkdir(tree, { recursive: true });
  await fs.writeFile(path.join(gitDir, 'commondir'), '../..\n');
  await fs.writeFile(path.join(tree, '.git'), `gitdir: ${gitDir}\n`);
  return tree;
}

describe('ワークツリーでの置き場所', () => {
  it('メインのチェックアウトでは DB も計画も root の下', () => {
    const paths = resolvePaths(root, {});

    expect(paths.dbPath).toBe(path.join(root, '.ai-board', 'board.db'));
    expect(paths.dbSource).toBe('local');
  });

  it('リンクされたワークツリーでは DB をメインのチェックアウトから、計画をワークツリーから読む', async () => {
    const tree = await makeLinkedWorktree('feature');

    const paths = resolvePaths(tree, {});

    expect(paths.dbPath).toBe(path.join(root, '.ai-board', 'board.db'));
    expect(paths.dbSource).toBe('main-checkout');
    expect(paths.plansDir).toBe(path.join(tree, '.ai-board', 'plans'));
  });

  it('リンクされたワークツリーでは config.yaml もメインのチェックアウトのものを読む', async () => {
    await writeConfig(githubYaml);
    const tree = await makeLinkedWorktree('feature');

    expect(loadConfig(tree).forge).toEqual({ kind: 'github', owner: 'iepyon', repo: 'ai-board' });
  });

  it('AI_BOARD_DB があれば、それを DB の場所にする（相対パスはカレントディレクトリから）', async () => {
    const tree = await makeLinkedWorktree('feature');

    const paths = resolvePaths(tree, { AI_BOARD_DB: 'dev.db' });

    expect(paths.dbPath).toBe(path.resolve('dev.db'));
    expect(paths.dbSource).toBe('env');
  });

  it('AI_BOARD_DB が空なら無いものとして扱う', () => {
    expect(resolvePaths(root, { AI_BOARD_DB: '' }).dbSource).toBe('local');
  });

  it('ワークツリーを読み解けなければ警告し、root の下の DB を使う', async () => {
    await fs.writeFile(path.join(root, '.git'), 'garbage\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      expect(resolvePaths(root, {}).dbPath).toBe(path.join(root, '.ai-board', 'board.db'));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('メインのチェックアウトを求められない')
      );
    } finally {
      warn.mockRestore();
    }
  });
});
