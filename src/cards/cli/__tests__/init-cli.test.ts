import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCliRunner } from '../../../infrastructure/cli-runner.js';
import { createDataStore, DATA_BRANCH } from '../../../infrastructure/data-store.js';
import { isErr } from '../../../shared/result.js';
import type { Card } from '../../models/card.js';
import { createFileCardDependencies } from '../../composition.js';
import { runInitCli, type InitCliDependencies } from '../init-cli.js';

// ============================================================
// 一時ディレクトリの bare リポジトリを origin にして、本物の git で確かめる
// ============================================================

let tmp: string;
let stdout: string;
let stderr: string;

const runner = createCliRunner({ timeoutMs: 30_000 });

vi.setConfig({ testTimeout: 30_000 });

function sh(args: readonly string[], cwd?: string): string {
  return execFileSync('git', [...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(cwd === undefined ? {} : { cwd }),
  }).trim();
}

function git(dir: string, ...args: string[]): string {
  return sh(['-C', dir, ...args]);
}

/** 空の bare リポジトリを作る */
function bare(name: string): string {
  const dir = path.join(tmp, name);
  sh(['init', '--quiet', '--bare', dir]);
  return dir;
}

/** origin の data ブランチのコミットの件名。ブランチが無ければ null */
function originLog(origin: string): string[] | null {
  const heads = git(origin, 'for-each-ref', `refs/heads/${DATA_BRANCH}`);
  if (heads === '') return null;
  return git(origin, 'log', '--format=%s', DATA_BRANCH).split('\n');
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-init-cli-')));

  const globalConfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_AUTHOR_NAME', 'ai-board');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'ai-board@example.com');
  vi.stubEnv('GIT_COMMITTER_NAME', 'ai-board');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'ai-board@example.com');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  stdout = '';
  stderr = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const io = {
  stdout: (text: string) => {
    stdout += text;
  },
  stderr: (text: string) => {
    stderr += text;
  },
};

// ============================================================
// コードのリポジトリとデータ用ブランチの用意
// ============================================================

/** コードのリポジトリ（既定の置き場所）。origin にコードのブランチを 1 つ push してある */
interface CodeRepo {
  readonly root: string;
  readonly origin: string;
  readonly boardDir: string;
  readonly dataDir: string;
}

function codeRepo(withOrigin = true): CodeRepo {
  const root = path.join(tmp, 'repo');
  const origin = path.join(tmp, 'code.git');

  if (withOrigin) {
    bare('code.git');
    sh(['clone', '--quiet', origin, root]);
  } else {
    sh(['init', '--quiet', root]);
  }
  fs.writeFileSync(path.join(root, 'README.md'), 'コード\n');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'init');
  if (withOrigin) git(root, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');

  const boardDir = path.join(root, '.ai-board');
  fs.mkdirSync(boardDir, { recursive: true });
  return { root, origin, boardDir, dataDir: path.join(boardDir, 'data') };
}

function defaultDeps(repo: CodeRepo): InitCliDependencies {
  return {
    target: { dataDir: repo.dataDir, repoRoot: repo.root, runner },
    configFile: path.join(repo.boardDir, 'config.yaml'),
  };
}

function envDeps(dataDir: string): InitCliDependencies {
  return {
    target: { dataDir, runner },
    configFile: path.join(tmp, 'none', 'config.yaml'),
  };
}

/** データ用ブランチのワークツリーを読み直す（取り直してから読む） */
async function readBack(dataDir: string, repoRoot?: string): Promise<Card[]> {
  const store = createDataStore({
    dataDir,
    ...(repoRoot === undefined ? {} : { repoRoot }),
    runner,
    lockPollMs: 10,
  });
  const refreshed = await store.refresh();
  if (isErr(refreshed)) throw new Error(JSON.stringify(refreshed.error));
  return createFileCardDependencies(dataDir).cardRepository.findAll();
}

// ============================================================
// テスト
// ============================================================

describe('ai-board init（既定の置き場所）', () => {
  it('空のデータ用ブランチを作り、1 コミットで push する', async () => {
    const repo = codeRepo();

    expect(await runInitCli([], defaultDeps(repo), io)).toBe(0);

    expect(stdout).toContain('空のデータ用ブランチを作りました');
    expect(stdout).toContain('origin の ai-board/data へ push しました');
    expect(originLog(repo.origin)).toEqual(['data: 空のデータ用ブランチを作る']);
    expect(git(repo.dataDir, 'ls-files').split('\n').sort()).toEqual([
      'ai-board-data.yaml',
      'order.yaml',
    ]);
    expect(await readBack(repo.dataDir, repo.root)).toEqual([]);

    // 作った後も、ワークツリーのコードのブランチは変わらない
    expect(git(repo.root, 'rev-parse', '--abbrev-ref', 'HEAD')).not.toBe(DATA_BRANCH);
  });

  it('.ai-board/config.yaml があれば、データ用ブランチの根に写す', async () => {
    const repo = codeRepo();
    fs.writeFileSync(path.join(repo.boardDir, 'config.yaml'), 'github:\n  repository: a/b\n');

    expect(await runInitCli([], defaultDeps(repo), io)).toBe(0);

    expect(git(repo.dataDir, 'ls-files').split('\n').sort()).toEqual([
      'ai-board-data.yaml',
      'config.yaml',
      'order.yaml',
    ]);
    expect(fs.readFileSync(path.join(repo.dataDir, 'config.yaml'), 'utf-8')).toContain('a/b');
  });

  it('origin に既にデータ用ブランチがあれば、何もせずに止まる', async () => {
    const repo = codeRepo();
    expect(await runInitCli([], defaultDeps(repo), io)).toBe(0);
    git(repo.root, 'worktree', 'remove', '--force', repo.dataDir);
    git(repo.root, 'branch', '--quiet', '-D', DATA_BRANCH);
    const before = git(repo.origin, 'rev-parse', DATA_BRANCH);

    expect(await runInitCli([], defaultDeps(repo), io)).toBe(1);

    expect(stderr).toContain('既にあります');
    expect(git(repo.origin, 'rev-parse', DATA_BRANCH)).toBe(before);
    expect(fs.existsSync(repo.dataDir)).toBe(false);
  });

  it('手元にデータ用ブランチがあれば止まる', async () => {
    const repo = codeRepo();
    git(repo.root, 'branch', DATA_BRANCH);

    expect(await runInitCli([], defaultDeps(repo), io)).toBe(1);

    expect(stderr).toContain('git branch -D ai-board/data');
    expect(originLog(repo.origin)).toBeNull();
  });

  it('データのワークツリーの場所に既にファイルがあれば止まる', async () => {
    const repo = codeRepo();
    fs.mkdirSync(repo.dataDir);
    fs.writeFileSync(path.join(repo.dataDir, 'stray.txt'), '');

    expect(await runInitCli([], defaultDeps(repo), io)).toBe(1);

    expect(stderr).toContain('既にファイルがあります');
    expect(originLog(repo.origin)).toBeNull();
  });

  it('origin が無ければ、push せずにコミットだけする', async () => {
    const repo = codeRepo(false);

    expect(await runInitCli([], defaultDeps(repo), io)).toBe(0);

    expect(stdout).toContain('push せずに');
    expect(git(repo.dataDir, 'log', '--format=%s')).toBe('data: 空のデータ用ブランチを作る');
  });
});

describe('ai-board init（AI_BOARD_DATA）', () => {
  it('空の clone にデータ用ブランチを作って push する', async () => {
    const origin = bare('origin.git');
    const dataDir = path.join(tmp, 'data');
    sh(['clone', '--quiet', origin, dataDir]);

    expect(await runInitCli([], envDeps(dataDir), io)).toBe(0);

    expect(originLog(origin)).toEqual(['data: 空のデータ用ブランチを作る']);
    expect(await readBack(dataDir)).toEqual([]);
  });

  it('clone でなければ止まる', async () => {
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir);

    expect(await runInitCli([], envDeps(dataDir), io)).toBe(1);

    expect(stderr).toContain('git の clone ではありません');
  });

  it('ファイルのある clone では、それがデータ用ブランチに入るので止まる', async () => {
    const origin = bare('origin.git');
    const dataDir = path.join(tmp, 'data');
    sh(['clone', '--quiet', origin, dataDir]);
    fs.writeFileSync(path.join(dataDir, 'README.md'), '');

    expect(await runInitCli([], envDeps(dataDir), io)).toBe(1);

    expect(stderr).toContain('既にファイルがあります');
    expect(originLog(origin)).toBeNull();
  });
});

describe('引数', () => {
  it('--help で使い方を出す', async () => {
    const repo = codeRepo();

    expect(await runInitCli(['--help'], defaultDeps(repo), io)).toBe(0);

    expect(stderr).toContain('使い方: ai-board init');
    expect(fs.existsSync(repo.dataDir)).toBe(false);
  });

  it.each([['--force'], ['--empty'], ['--from']])('不明な引数（%s）では何もしない', async (arg) => {
    const repo = codeRepo();

    expect(await runInitCli([arg], defaultDeps(repo), io)).toBe(1);

    expect(stderr).toContain(`不明な引数です: ${arg}`);
    expect(stderr).toContain('使い方: ai-board init');
    expect(fs.existsSync(repo.dataDir)).toBe(false);
  });
});
