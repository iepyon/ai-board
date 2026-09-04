import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadConfig, resolvePaths, GITLAB_TOKEN_ENV } from '../config.js';

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

const validYaml = 'gitlab:\n  url: http://localhost:8080\n  projectId: 3\n';

describe('resolvePaths', () => {
  it('プロジェクトルートから各ディレクトリを導く', () => {
    const paths = resolvePaths(root);

    expect(paths.boardDir).toBe(path.join(root, '.ai-board'));
    expect(paths.cardsDir).toBe(path.join(root, '.ai-board', 'cards'));
    expect(paths.openspecDir).toBe(path.join(root, 'openspec'));
  });

  it('相対パスを絶対パスにする', () => {
    expect(path.isAbsolute(resolvePaths('.').root)).toBe(true);
  });
});

describe('loadConfig', () => {
  it('設定ファイルが無ければ GitLab を無効にする', () => {
    expect(loadConfig(root, {}).gitlab).toBeNull();
  });

  it('gitlab セクションがあってもトークンが無ければ無効にする', async () => {
    await writeConfig(validYaml);

    expect(loadConfig(root, {}).gitlab).toBeNull();
  });

  it('トークンがあっても gitlab セクションが無ければ無効にする', async () => {
    await writeConfig('# 空の設定\n');

    expect(loadConfig(root, { [GITLAB_TOKEN_ENV]: 'secret' }).gitlab).toBeNull();
  });

  it('両方そろって初めて GitLab を有効にする', async () => {
    await writeConfig(validYaml);

    const config = loadConfig(root, { [GITLAB_TOKEN_ENV]: 'secret' });

    expect(config.gitlab).toEqual({
      url: 'http://localhost:8080',
      projectId: 3,
      token: 'secret',
    });
  });

  it('URL 末尾のスラッシュを取り除く', async () => {
    await writeConfig('gitlab:\n  url: http://localhost:8080///\n  projectId: 3\n');

    expect(loadConfig(root, { [GITLAB_TOKEN_ENV]: 'secret' }).gitlab?.url).toBe(
      'http://localhost:8080'
    );
  });

  it('projectId はパス形式の文字列も受け付ける', async () => {
    await writeConfig('gitlab:\n  url: http://localhost:8080\n  projectId: group/project\n');

    expect(loadConfig(root, { [GITLAB_TOKEN_ENV]: 'secret' }).gitlab?.projectId).toBe(
      'group/project'
    );
  });

  it('設定ファイルにトークンを書いても読み取らない', async () => {
    await writeConfig(`${validYaml}  token: written-in-file\n`);

    // 環境変数が無い以上、ファイルに書かれていても有効にはならない
    expect(loadConfig(root, {}).gitlab).toBeNull();
  });

  it('不正な設定はエラーにする', async () => {
    await writeConfig('gitlab:\n  url: not-a-url\n  projectId: 3\n');

    expect(() => loadConfig(root, { [GITLAB_TOKEN_ENV]: 'secret' })).toThrow(/config.yaml/);
  });

  it('url が欠けていればエラーにする', async () => {
    await writeConfig('gitlab:\n  projectId: 3\n');

    expect(() => loadConfig(root, { [GITLAB_TOKEN_ENV]: 'secret' })).toThrow();
  });
});
