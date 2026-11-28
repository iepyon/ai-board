import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, plansLiveInStore, resolvePaths } from '../config.js';

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
  });

  it('リンクされたワークツリーでは、共有の置き場所をメインのチェックアウトに、計画をワークツリーに置く', async () => {
    const tree = await makeLinkedWorktree('feature');

    const paths = resolvePaths(tree, {});

    expect(paths.sharedBoardDir).toBe(path.join(root, '.ai-board'));
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
      expect(resolvePaths(root, {}).localDir).toBe(path.join(root, '.ai-board', 'local'));
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('メインのチェックアウトを求められない')
      );
    } finally {
      warn.mockRestore();
    }
  });
});

// ============================================================
// 手元のディレクトリと、置き場所のリモート・ブランチ
// ============================================================

describe('手元のディレクトリ', () => {
  it('メインのチェックアウトでは .ai-board/local/ で、git はメインのチェックアウトで走らせる', () => {
    const paths = resolvePaths(root, {});

    expect(paths.localDir).toBe(path.join(root, '.ai-board', 'local'));
    expect(paths.repoDir).toBe(root);
    expect(paths.storeOverride).toBeNull();
  });

  it('リンクされたワークツリーではメインのチェックアウトの .ai-board/local/', async () => {
    const tree = await makeLinkedWorktree('feature');

    const paths = resolvePaths(tree, {});

    expect(paths.localDir).toBe(path.join(root, '.ai-board', 'local'));
    expect(paths.repoDir).toBe(root);
  });

  it('AI_BOARD_STORE があれば、それを置き場所のリポジトリにし、手元のファイルはその隣に置く（相対パスはカレントディレクトリから）', async () => {
    const tree = await makeLinkedWorktree('feature');

    const paths = resolvePaths(tree, { AI_BOARD_STORE: 'dev-store.git' });

    expect(paths.storeOverride).toBe(path.resolve('dev-store.git'));
    expect(paths.localDir).toBe(`${path.resolve('dev-store.git')}.local`);
  });

  it('AI_BOARD_STORE が空なら無いものとして扱う', () => {
    expect(resolvePaths(root, { AI_BOARD_STORE: '' }).storeOverride).toBeNull();
  });

  it('AI_BOARD_STORE があっても、共有の .ai-board/ はメインのチェックアウトを指す', () => {
    const paths = resolvePaths(root, { AI_BOARD_STORE: 'dev-store.git' });

    expect(paths.sharedBoardDir).toBe(path.join(root, '.ai-board'));
  });
});

describe('store', () => {
  it('書かれていなければ origin の main', async () => {
    await writeConfig(githubYaml);

    expect(loadConfig(root, {}).store).toEqual({
      remote: 'origin',
      branch: 'ai-board-data',
      planBranch: 'main',
      branchRemote: 'origin',
    });
  });

  it('store.planBranch を読む。置き場所が同じリモートの同じブランチのときだけ、計画は置き場所から読む', async () => {
    await writeConfig(`${githubYaml}store:\n  branch: main\n`);
    const same = loadConfig(root, {}).store;
    expect(same.planBranch).toBe('main');
    expect(plansLiveInStore(same)).toBe(true);

    await writeConfig(`${githubYaml}store:\n  planBranch: trunk\n`);
    const split = loadConfig(root, {}).store;
    expect(split.planBranch).toBe('trunk');
    expect(plansLiveInStore(split)).toBe(false);
    expect(plansLiveInStore(loadConfig(root, { AI_BOARD_STORE: '/tmp/x.git' }).store)).toBe(false);
  });

  it('store.planBranch に git のブランチの名前でない値を書けばエラーにする', async () => {
    await writeConfig('store:\n  planBranch: "a b"\n');
    expect(() => loadConfig(root, {})).toThrow('store.planBranch');
  });

  it('store.remote と store.branch を読む', async () => {
    await writeConfig(`${githubYaml}store:\n  remote: upstream\n  branch: board\n`);

    expect(loadConfig(root, {}).store).toEqual({
      remote: 'upstream',
      branch: 'board',
      planBranch: 'main',
      branchRemote: 'upstream',
    });
  });

  it('AI_BOARD_STORE があれば、そのリポジトリを置き場所のリモートにし、カードのブランチは設定のリモートで追う', async () => {
    await writeConfig(`${githubYaml}store:\n  remote: upstream\n`);

    expect(loadConfig(root, { AI_BOARD_STORE: '/tmp/x.git' }).store).toEqual({
      remote: '/tmp/x.git',
      branch: 'ai-board-data',
      planBranch: 'main',
      branchRemote: 'upstream',
    });
  });

  it('- で始まる値は、ファイルの名前を出してエラーにする', async () => {
    await writeConfig('store:\n  branch: --force\n');

    expect(() => loadConfig(root, {})).toThrow(path.join(root, '.ai-board', 'config.yaml'));
  });

  it.each(["'data:x'", 'a..b', 'x.lock', 'feat/', 'a~1', '.hidden', 'a/.b'])(
    'store.branch に git のブランチの名前でない値（%s）を書けばエラーにする',
    async (branch) => {
      await writeConfig(`store:\n  branch: ${branch}\n`);

      expect(() => loadConfig(root, {})).toThrow('store.branch');
    }
  );

  it('store.branch に / を含む名前は書ける', async () => {
    await writeConfig('store:\n  branch: board/data\n');

    expect(loadConfig(root, {}).store.branch).toBe('board/data');
  });
});
