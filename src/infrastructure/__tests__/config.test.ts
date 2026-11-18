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
  it('メインのチェックアウトでは、共有の置き場所も計画も root の下', () => {
    const paths = resolvePaths(root, {});

    expect(paths.sharedBoardDir).toBe(path.join(root, '.ai-board'));
    expect(paths.plansDir).toBe(path.join(root, '.ai-board', 'plans'));
  });

  it('リンクされたワークツリーでは、共有の置き場所をメインのチェックアウトに、計画をワークツリーに置く', async () => {
    const tree = await makeLinkedWorktree('feature');

    const paths = resolvePaths(tree, {});

    expect(paths.sharedBoardDir).toBe(path.join(root, '.ai-board'));
    expect(paths.plansDir).toBe(path.join(tree, '.ai-board', 'plans'));
  });

  it('リンクされたワークツリーでは、git に載せたワークツリー自身の config.yaml を読む', async () => {
    await writeConfig('github:\n  repository: main/checkout\n');
    const tree = await makeLinkedWorktree('feature');
    await fs.mkdir(path.join(tree, '.ai-board'), { recursive: true });
    await fs.writeFile(path.join(tree, '.ai-board', 'config.yaml'), githubYaml, 'utf-8');

    expect(loadConfig(tree).forge).toEqual({ kind: 'github', owner: 'iepyon', repo: 'ai-board' });
  });

  it('ワークツリーを読み解けなければ警告し、root の下のデータを使う', async () => {
    await fs.writeFile(path.join(root, '.git'), 'garbage\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      expect(resolvePaths(root, {}).storeDir).toBe(path.join(root, '.ai-board', 'store'));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('メインのチェックアウトを求められない')
      );
    } finally {
      warn.mockRestore();
    }
  });
});

// ============================================================
// 置き場所の写しのディレクトリと、store.url
// ============================================================

describe('置き場所の写しのディレクトリ', () => {
  it('メインのチェックアウトでは .ai-board/store/', () => {
    const paths = resolvePaths(root, {});

    expect(paths.storeDir).toBe(path.join(root, '.ai-board', 'store'));
    expect(paths.storeSource).toBe('local');
  });

  it('リンクされたワークツリーではメインのチェックアウトの .ai-board/store/', async () => {
    const tree = await makeLinkedWorktree('feature');

    const paths = resolvePaths(tree, {});

    expect(paths.storeDir).toBe(path.join(root, '.ai-board', 'store'));
    expect(paths.storeSource).toBe('main-checkout');
  });

  it('AI_BOARD_STORE があれば、それを写しのディレクトリにする（相対パスはカレントディレクトリから）', async () => {
    const tree = await makeLinkedWorktree('feature');

    const paths = resolvePaths(tree, { AI_BOARD_STORE: 'dev-store' });

    expect(paths.storeDir).toBe(path.resolve('dev-store'));
    expect(paths.storeSource).toBe('env');
  });

  it('AI_BOARD_STORE が空なら無いものとして扱う', () => {
    expect(resolvePaths(root, { AI_BOARD_STORE: '' }).storeSource).toBe('local');
  });

  it('AI_BOARD_STORE があっても、共有の置き場所は .ai-board/ を指す', () => {
    const paths = resolvePaths(root, { AI_BOARD_STORE: 'dev-store' });

    expect(paths.sharedBoardDir).toBe(path.join(root, '.ai-board'));
  });
});

describe('store.url', () => {
  it('書かれていなければ null', async () => {
    await writeConfig(githubYaml);

    expect(loadConfig(root, {}).storeUrl).toBeNull();
  });

  it('claude.ai の Artifact の URL を読む', async () => {
    await writeConfig(`${githubYaml}store:\n  url: https://claude.ai/artifact/AbC123\n`);

    expect(loadConfig(root, {}).storeUrl).toBe('https://claude.ai/artifact/AbC123');
  });

  it('claude.ai/code/artifact の URL も読む', async () => {
    await writeConfig('store:\n  url: https://claude.ai/code/artifact/1a2b-3c\n');

    expect(loadConfig(root, {}).storeUrl).toBe('https://claude.ai/code/artifact/1a2b-3c');
  });

  it('url: null は未設定として読む', async () => {
    await writeConfig('store:\n  url: null\n');

    expect(loadConfig(root, {}).storeUrl).toBeNull();
  });

  it('Artifact の URL でなければ、ファイルの名前を出してエラーにする', async () => {
    await writeConfig('store:\n  url: https://example.com/x\n');

    expect(() => loadConfig(root, {})).toThrow(path.join(root, '.ai-board', 'config.yaml'));
  });
});
