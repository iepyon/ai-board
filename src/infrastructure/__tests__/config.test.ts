import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, readDataMode, resolvePaths } from '../config.js';

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

  it('リンクされたワークツリーでは config.yaml もメインのチェックアウトのものを読む', async () => {
    await writeConfig(githubYaml);
    const tree = await makeLinkedWorktree('feature');

    expect(loadConfig(tree).forge).toEqual({ kind: 'github', owner: 'iepyon', repo: 'ai-board' });
  });

  it('ワークツリーを読み解けなければ警告し、root の下のデータを使う', async () => {
    await fs.writeFile(path.join(root, '.git'), 'garbage\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      expect(resolvePaths(root, {}).dataDir).toBe(path.join(root, '.ai-board', 'data'));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('メインのチェックアウトを求められない')
      );
    } finally {
      warn.mockRestore();
    }
  });
});

// ============================================================
// データのワークツリーと、config.yaml の置き場所
// ============================================================

async function writeDataConfig(dataDir: string, yaml: string): Promise<void> {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'config.yaml'), yaml, 'utf-8');
}

describe('データのワークツリーの置き場所', () => {
  it('メインのチェックアウトでは .ai-board/data/', () => {
    const paths = resolvePaths(root, {});

    expect(paths.dataDir).toBe(path.join(root, '.ai-board', 'data'));
    expect(paths.dataSource).toBe('local');
  });

  it('リンクされたワークツリーではメインのチェックアウトの .ai-board/data/', async () => {
    const tree = await makeLinkedWorktree('feature');

    const paths = resolvePaths(tree, {});

    expect(paths.dataDir).toBe(path.join(root, '.ai-board', 'data'));
    expect(paths.dataSource).toBe('main-checkout');
  });

  it('AI_BOARD_DATA があれば、それをデータのワークツリーにする（相対パスはカレントディレクトリから）', async () => {
    const tree = await makeLinkedWorktree('feature');

    const paths = resolvePaths(tree, { AI_BOARD_DATA: 'dev-data' });

    expect(paths.dataDir).toBe(path.resolve('dev-data'));
    expect(paths.dataSource).toBe('env');
  });

  it('AI_BOARD_DATA が空なら無いものとして扱う', () => {
    expect(resolvePaths(root, { AI_BOARD_DATA: '' }).dataSource).toBe('local');
  });

  it('AI_BOARD_DATA があっても、共有の置き場所は .ai-board/ を指す', () => {
    const paths = resolvePaths(root, { AI_BOARD_DATA: 'dev-data' });

    expect(paths.sharedBoardDir).toBe(path.join(root, '.ai-board'));
  });
});

describe('config.yaml の置き場所', () => {
  it('データ用ブランチの根に config.yaml があれば、それを読む', async () => {
    await writeConfig('github:\n  repository: old/repo\n');
    await writeDataConfig(path.join(root, '.ai-board', 'data'), githubYaml);

    expect(loadConfig(root, {}).forge).toEqual({
      kind: 'github',
      owner: 'iepyon',
      repo: 'ai-board',
    });
  });

  it('データ用ブランチに無ければ .ai-board/config.yaml を読む', async () => {
    await writeConfig(githubYaml);
    await fs.mkdir(path.join(root, '.ai-board', 'data'), { recursive: true });

    expect(loadConfig(root, {}).forge).toEqual({
      kind: 'github',
      owner: 'iepyon',
      repo: 'ai-board',
    });
  });

  it('リンクされたワークツリーでは、メインのチェックアウトのデータのワークツリーの config.yaml を読む', async () => {
    await writeDataConfig(path.join(root, '.ai-board', 'data'), githubYaml);
    const tree = await makeLinkedWorktree('feature');

    expect(loadConfig(tree, {}).forge).toEqual({
      kind: 'github',
      owner: 'iepyon',
      repo: 'ai-board',
    });
  });

  it('AI_BOARD_DATA を指せば、そのディレクトリの config.yaml を読む', async () => {
    await writeConfig('github:\n  repository: old/repo\n');
    const dataDir = path.join(root, 'elsewhere');
    await writeDataConfig(dataDir, githubYaml);

    expect(loadConfig(root, { AI_BOARD_DATA: dataDir }).forge).toEqual({
      kind: 'github',
      owner: 'iepyon',
      repo: 'ai-board',
    });
  });

  it('データ用ブランチの config.yaml が不正なら、そのファイルの名前を出してエラーにする', async () => {
    const dataDir = path.join(root, '.ai-board', 'data');
    await writeDataConfig(dataDir, 'github:\n  repository: 3\n');

    expect(() => loadConfig(root, {})).toThrow(path.join(dataDir, 'config.yaml'));
  });
});

describe('データ用ブランチの読み書きのモード', () => {
  async function writeMode(dir: string, yaml: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'data-mode.yaml'), yaml, 'utf-8');
  }

  it('data-mode.yaml が無ければ既定のモード（sync）', () => {
    expect(readDataMode(resolvePaths(root, {}).dataDir)).toBe('sync');
  });

  it('mode: local なら手元モード', async () => {
    await writeMode(path.join(root, '.ai-board'), 'mode: local\n');

    expect(readDataMode(resolvePaths(root, {}).dataDir)).toBe('local');
  });

  it('mode: sync なら既定のモード', async () => {
    await writeMode(path.join(root, '.ai-board'), 'mode: sync\n');

    expect(readDataMode(resolvePaths(root, {}).dataDir)).toBe('sync');
  });

  it('形が違えば警告して既定のモードにする', async () => {
    await writeMode(path.join(root, '.ai-board'), 'mode: offline\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      expect(readDataMode(resolvePaths(root, {}).dataDir)).toBe('sync');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('data-mode.yaml を読めないため'));
    } finally {
      warn.mockRestore();
    }
  });

  it('YAML として読めなければ警告して既定のモードにする', async () => {
    await writeMode(path.join(root, '.ai-board'), 'mode: [local\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      expect(readDataMode(resolvePaths(root, {}).dataDir)).toBe('sync');
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('リンクされたワークツリーでは、メインのチェックアウトの data-mode.yaml を読む', async () => {
    const tree = await makeLinkedWorktree('feature');
    await writeMode(path.join(root, '.ai-board'), 'mode: local\n');

    expect(readDataMode(resolvePaths(tree, {}).dataDir)).toBe('local');
  });

  it('AI_BOARD_DATA を指したときは、指した先の隣の data-mode.yaml を読み、本物のものは読まない', async () => {
    await writeMode(path.join(root, '.ai-board'), 'mode: local\n');
    const trial = path.join(root, 'trial');
    const dataDir = path.join(trial, 'data');

    expect(readDataMode(resolvePaths(root, { AI_BOARD_DATA: dataDir }).dataDir)).toBe('sync');

    await writeMode(trial, 'mode: local\n');
    expect(readDataMode(resolvePaths(root, { AI_BOARD_DATA: dataDir }).dataDir)).toBe('local');
  });
});
