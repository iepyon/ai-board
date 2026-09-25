import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, resolvePaths } from '../config.js';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-config-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeConfig(yaml: string): Promise<void> {
  const dir = path.join(root, '.ai-board');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'config.yaml'), yaml, 'utf-8');
}

const gitlabYaml = 'gitlab:\n  url: http://localhost:8929\n  projectId: 3\n';
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

  it('gitlab が書かれていればトークン無しでも有効にする', async () => {
    await writeConfig(gitlabYaml);

    expect(loadConfig(root).forge).toEqual({
      kind: 'gitlab',
      url: 'http://localhost:8929',
      projectId: 3,
    });
  });

  it('github が書かれていれば owner と repo に分けて有効にする', async () => {
    await writeConfig(githubYaml);

    expect(loadConfig(root).forge).toEqual({
      kind: 'github',
      owner: 'iepyon',
      repo: 'ai-board',
    });
  });

  it('URL 末尾のスラッシュを取り除く', async () => {
    await writeConfig('gitlab:\n  url: http://localhost:8929///\n  projectId: 3\n');

    expect(loadConfig(root).forge).toMatchObject({ url: 'http://localhost:8929' });
  });

  it('projectId はパス形式の文字列も受け付ける', async () => {
    await writeConfig('gitlab:\n  url: http://localhost:8929\n  projectId: group/project\n');

    expect(loadConfig(root).forge).toMatchObject({ projectId: 'group/project' });
  });

  it('gitlab と github を同時に書いたらエラーにする', async () => {
    await writeConfig(`${gitlabYaml}${githubYaml}`);

    expect(() => loadConfig(root)).toThrow(/同時に指定できない/);
  });

  it('設定ファイルにトークンを書いても読み取らない', async () => {
    await writeConfig(`${gitlabYaml}  token: written-in-file\n`);

    const forge = loadConfig(root).forge;

    expect(forge).not.toBeNull();
    expect(JSON.stringify(forge)).not.toContain('written-in-file');
  });

  it('環境変数にトークンがあっても設定には現れない', async () => {
    await writeConfig(gitlabYaml);
    process.env.AI_BOARD_GITLAB_TOKEN = 'secret';

    try {
      expect(JSON.stringify(loadConfig(root).forge)).not.toContain('secret');
    } finally {
      delete process.env.AI_BOARD_GITLAB_TOKEN;
    }
  });

  it('repository が owner/repo の形でなければエラーにする', async () => {
    await writeConfig('github:\n  repository: ai-board\n');

    expect(() => loadConfig(root)).toThrow(/owner\/repo/);
  });

  it('不正な設定はエラーにする', async () => {
    await writeConfig('gitlab:\n  url: not-a-url\n  projectId: 3\n');

    expect(() => loadConfig(root)).toThrow(/config.yaml/);
  });

  it('url が欠けていればエラーにする', async () => {
    await writeConfig('gitlab:\n  projectId: 3\n');

    expect(() => loadConfig(root)).toThrow();
  });
});
