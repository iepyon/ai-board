import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCliRunner } from '../../../infrastructure/cli-runner.js';
import { createDataStore, DATA_BRANCH } from '../../../infrastructure/data-store.js';
import { readLegacyBoard } from '../../../infrastructure/database.js';
import {
  createLegacyDatabase,
  type LegacyFixture,
} from '../../../infrastructure/__tests__/legacy-database-fixture.js';
import type { CardId, MergeRequestIid } from '../../../shared/schemas/common.js';
import { isErr } from '../../../shared/result.js';
import type { MrSnapshot } from '../../../board/models/mr-state.js';
import type { Card } from '../../models/card.js';
import { createFileCardDependencies } from '../../composition.js';
import {
  compareMigratedCards,
  runMigrateCli,
  type MigrateCliDependencies,
} from '../migrate-cli.js';

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
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-migrate-cli-')));

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
// 移行元と移行先の用意
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

function defaultDeps(repo: CodeRepo): MigrateCliDependencies {
  return {
    target: { dataDir: repo.dataDir, repoRoot: repo.root, runner },
    defaultFrom: path.join(repo.boardDir, 'board.db'),
    configFile: path.join(repo.boardDir, 'config.yaml'),
    readLegacy: readLegacyBoard,
  };
}

function legacyDb(repo: CodeRepo, fixture: LegacyFixture): void {
  createLegacyDatabase(path.join(repo.boardDir, 'board.db'), fixture);
}

function card(id: string, overrides: Partial<Card> = {}): Card {
  return {
    id: id as CardId,
    title: `${id} のタイトル`,
    created: '2026-09-01T00:00:00.000Z',
    startedAt: null,
    skipGates: [],
    branch: null,
    mr: null,
    rank: null,
    body: '## アイデア\n\n本文',
    ...overrides,
  };
}

function snapshot(state: 'opened' | 'merged', iid: number): MrSnapshot {
  return {
    fingerprint: `fp-${iid}`,
    mr: {
      forge: 'github',
      iid: iid as MergeRequestIid,
      state,
      draft: false,
      sourceBranch: `b-${iid}`,
      title: 'PR',
      webUrl: `https://example.com/pr/${iid}`,
      latestNoteAt: null,
      noteCount: 0,
      latestCommitAt: null,
      mergedAt: state === 'merged' ? '2026-09-05T00:00:00.000Z' : null,
      readyAt: null,
      convertedToDraftAt: null,
    },
  };
}

/** 移行前の本文。verify 提出の理由の `## 動かす手順` で節が切れ、後ろの見出しが本文の節として読まれる */
const SPLIT_BODY = [
  '## アイデア',
  '',
  '本文',
  '',
  '## レビュー',
  '',
  '### 2026-09-02T00:00:00.000Z plan 提出',
  '',
  '### 2026-09-03T00:00:00Z plan 承認',
  '',
  'よい',
  '',
  '### 2026-09-04T00:00:00.000Z verify 提出',
  '',
  '動作確認を頼みます。',
  '',
  '## 動かす手順',
  '',
  '1. npm run build',
].join('\n');

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

describe('ai-board migrate（既定の置き場所）', () => {
  it('board.db のカードをデータ用ブランチに書き出し、1 コミットで push する', async () => {
    const repo = codeRepo();
    const cards = [
      card('alpha', {
        startedAt: '2026-09-01T12:00:00.000Z',
        skipGates: ['verify'],
        branch: 'alpha',
        mr: 7 as MergeRequestIid,
        rank: 1500,
        body: SPLIT_BODY,
      }),
      card('beta', { rank: 3000 }),
      card('gamma'),
    ];
    legacyDb(repo, {
      cards,
      divider: 2000,
      mrSnapshots: [
        ['alpha', snapshot('merged', 7)],
        ['beta', snapshot('opened', 8)],
      ],
    });
    fs.writeFileSync(path.join(repo.boardDir, 'config.yaml'), 'github:\n  repository: a/b\n');

    expect(await runMigrateCli([], defaultDeps(repo), io)).toBe(0);

    expect(stdout).toContain('3 枚のカード');
    expect(stdout).toContain('push しました');
    expect(originLog(repo.origin)).toEqual(['data: board.db から移す']);

    // 判断は元の時刻のまま 1 件 1 ファイル。着手は startedAt の時刻の 1 件
    expect(fs.readdirSync(path.join(repo.dataDir, 'cards', 'alpha', 'log')).sort()).toEqual([
      '20260901T120000.000Z.start.start.md',
      '20260902T000000.000Z.plan.submit.md',
      '20260903T000000.000Z.plan.approve.md',
      '20260904T000000.000Z.verify.submit.md',
    ]);
    expect(fs.readFileSync(path.join(repo.dataDir, 'order.yaml'), 'utf-8')).toContain(
      'divider: 2000'
    );
    expect(fs.readdirSync(path.join(repo.dataDir, 'snapshots'))).toEqual(['alpha.json']);
    expect(fs.readFileSync(path.join(repo.dataDir, 'config.yaml'), 'utf-8')).toContain('a/b');

    // 組み立て直したカードは DB のカードと一致する（## レビュー の後ろに節があるカードも）
    const migrated = await readBack(repo.dataDir, repo.root);
    expect(compareMigratedCards(cards, migrated)).toEqual([]);
    expect(migrated.find((c) => c.id === 'alpha')?.body).toContain('## 動かす手順');

    // 書き出した後は、ワークツリーのコードのブランチは変わらない
    expect(git(repo.root, 'rev-parse', '--abbrev-ref', 'HEAD')).not.toBe(DATA_BRANCH);
  });

  it('--from で別の DB を読む', async () => {
    const repo = codeRepo();
    const from = path.join(tmp, 'copy.db');
    createLegacyDatabase(from, { cards: [card('alpha')] });

    expect(await runMigrateCli(['--from', from], defaultDeps(repo), io)).toBe(0);

    expect(stdout).toContain(from);
    expect((await readBack(repo.dataDir, repo.root)).map((c) => c.id)).toEqual(['alpha']);
  });

  it('origin に既にデータ用ブランチがあれば、何もせずに止まる', async () => {
    const repo = codeRepo();
    legacyDb(repo, { cards: [card('alpha')] });
    expect(await runMigrateCli([], defaultDeps(repo), io)).toBe(0);
    git(repo.root, 'worktree', 'remove', '--force', repo.dataDir);
    git(repo.root, 'branch', '--quiet', '-D', DATA_BRANCH);
    const before = git(repo.origin, 'rev-parse', DATA_BRANCH);

    expect(await runMigrateCli([], defaultDeps(repo), io)).toBe(1);

    expect(stderr).toContain('既にあります');
    expect(git(repo.origin, 'rev-parse', DATA_BRANCH)).toBe(before);
    expect(fs.existsSync(repo.dataDir)).toBe(false);
  });

  it('手元にデータ用ブランチがあれば止まる', async () => {
    const repo = codeRepo();
    legacyDb(repo, { cards: [card('alpha')] });
    git(repo.root, 'branch', DATA_BRANCH);

    expect(await runMigrateCli([], defaultDeps(repo), io)).toBe(1);

    expect(stderr).toContain('git branch -D ai-board/data');
    expect(originLog(repo.origin)).toBeNull();
  });

  it('データのワークツリーの場所に既にファイルがあれば止まる', async () => {
    const repo = codeRepo();
    legacyDb(repo, { cards: [card('alpha')] });
    fs.mkdirSync(repo.dataDir);
    fs.writeFileSync(path.join(repo.dataDir, 'stray.txt'), '');

    expect(await runMigrateCli([], defaultDeps(repo), io)).toBe(1);

    expect(stderr).toContain('既にファイルがあります');
    expect(originLog(repo.origin)).toBeNull();
  });

  it('組み立て直したカードが DB と一致しなければ、データ用ブランチを作らずに止まる', async () => {
    const repo = codeRepo();
    // 同じミリ秒の判断は、ファイル名の順（承認 → 提出）に並び直り、DB の並び（提出 → 承認）と食い違う
    const body = [
      '## レビュー',
      '',
      '### 2026-09-02T00:00:00.000Z plan 提出',
      '',
      '### 2026-09-02T00:00:00.000Z plan 承認',
    ].join('\n');
    legacyDb(repo, { cards: [card('alpha'), card('swapped', { body })] });

    expect(await runMigrateCli([], defaultDeps(repo), io)).toBe(1);

    expect(stderr).toContain('一致しない');
    expect(stderr).toContain('swapped: ## レビュー のエントリ が一致しません');
    expect(stderr).not.toContain('alpha');
    expect(originLog(repo.origin)).toBeNull();
    expect(fs.existsSync(repo.dataDir)).toBe(false);
    expect(git(repo.root, 'branch', '--list', DATA_BRANCH)).toBe('');
  });

  it('DB が無ければ、--from か --empty を案内して止まる', async () => {
    const repo = codeRepo();

    expect(await runMigrateCli([], defaultDeps(repo), io)).toBe(1);

    expect(stderr).toContain('--empty');
    expect(fs.existsSync(repo.dataDir)).toBe(false);
  });

  it('push に失敗したら、作ったワークツリーとブランチを片付ける', async () => {
    const repo = codeRepo();
    legacyDb(repo, { cards: [card('alpha')] });
    const hook = path.join(repo.origin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    expect(await runMigrateCli([], defaultDeps(repo), io)).toBe(1);

    expect(stderr).toContain('push できませんでした');
    expect(originLog(repo.origin)).toBeNull();
    expect(fs.existsSync(repo.dataDir)).toBe(false);
    expect(git(repo.root, 'branch', '--list', DATA_BRANCH)).toBe('');
    expect(git(repo.root, 'worktree', 'list')).not.toContain(repo.dataDir);

    // 片付けたので、直してからやり直せる
    fs.rmSync(hook);
    expect(await runMigrateCli([], defaultDeps(repo), io)).toBe(0);
    expect(originLog(repo.origin)).toEqual(['data: board.db から移す']);
  });

  it('origin が無ければ、push せずにコミットだけする', async () => {
    const repo = codeRepo(false);
    legacyDb(repo, { cards: [card('alpha')] });

    expect(await runMigrateCli([], defaultDeps(repo), io)).toBe(0);

    expect(stdout).toContain('push せずに');
    expect(git(repo.dataDir, 'log', '--format=%s')).toBe('data: board.db から移す');
    expect((await readBack(repo.dataDir, repo.root)).map((c) => c.id)).toEqual(['alpha']);
  });
});

describe('ai-board migrate --empty', () => {
  it('DB を読まずに、空のデータ用ブランチを作る', async () => {
    const repo = codeRepo();

    expect(await runMigrateCli(['--empty'], defaultDeps(repo), io)).toBe(0);

    expect(stdout).toContain('空のデータ用ブランチ');
    expect(originLog(repo.origin)).toEqual(['data: 空のデータ用ブランチを作る']);
    expect(git(repo.dataDir, 'ls-files').split('\n').sort()).toEqual([
      'ai-board-data.yaml',
      'order.yaml',
    ]);
    expect(await readBack(repo.dataDir, repo.root)).toEqual([]);
  });

  it('--from と一緒には指定できない', async () => {
    const repo = codeRepo();

    expect(await runMigrateCli(['--empty', '--from', 'x.db'], defaultDeps(repo), io)).toBe(1);

    expect(stderr).toContain('一緒に指定できません');
    expect(originLog(repo.origin)).toBeNull();
  });
});

describe('ai-board migrate（AI_BOARD_DATA）', () => {
  function envDeps(dataDir: string, dbPath: string): MigrateCliDependencies {
    return {
      target: { dataDir, runner },
      defaultFrom: dbPath,
      configFile: path.join(tmp, 'none', 'config.yaml'),
      readLegacy: readLegacyBoard,
    };
  }

  it('空の clone にデータ用ブランチを作って push する', async () => {
    const origin = bare('origin.git');
    const dataDir = path.join(tmp, 'data');
    sh(['clone', '--quiet', origin, dataDir]);
    const dbPath = path.join(tmp, 'board.db');
    createLegacyDatabase(dbPath, { cards: [card('alpha', { rank: 1 })] });

    expect(await runMigrateCli([], envDeps(dataDir, dbPath), io)).toBe(0);

    expect(originLog(origin)).toEqual(['data: board.db から移す']);
    expect((await readBack(dataDir)).map((c) => [c.id, c.rank])).toEqual([['alpha', 1]]);
  });

  it('clone でなければ止まる', async () => {
    const dataDir = path.join(tmp, 'data');
    fs.mkdirSync(dataDir);

    expect(await runMigrateCli(['--empty'], envDeps(dataDir, 'x.db'), io)).toBe(1);

    expect(stderr).toContain('git の clone ではありません');
  });

  it('ファイルのある clone では、それがデータ用ブランチに入るので止まる', async () => {
    const origin = bare('origin.git');
    const dataDir = path.join(tmp, 'data');
    sh(['clone', '--quiet', origin, dataDir]);
    fs.writeFileSync(path.join(dataDir, 'README.md'), '');

    expect(await runMigrateCli(['--empty'], envDeps(dataDir, 'x.db'), io)).toBe(1);

    expect(stderr).toContain('既にファイルがあります');
    expect(originLog(origin)).toBeNull();
  });
});

describe('引数', () => {
  it('--help で使い方を出す', async () => {
    const repo = codeRepo();

    expect(await runMigrateCli(['--help'], defaultDeps(repo), io)).toBe(0);

    expect(stderr).toContain('使い方: ai-board migrate');
  });

  it('不明な引数では何もしない', async () => {
    const repo = codeRepo();

    expect(await runMigrateCli(['--force'], defaultDeps(repo), io)).toBe(1);

    expect(stderr).toContain('不明な引数です: --force');
    expect(fs.existsSync(repo.dataDir)).toBe(false);
  });
});

describe('compareMigratedCards', () => {
  it('読めなかったカードと、DB に無いカードを挙げる', () => {
    expect(compareMigratedCards([card('alpha')], [card('beta')])).toEqual([
      'alpha: 書き出したカードが読めません',
      'beta: DB に無いカードが書き出されました',
    ]);
  });

  it('時刻は同じ瞬間なら一致とみなし、項目の違いは名前で挙げる', () => {
    const expected = card('alpha', { created: '2026-09-01T00:00:00Z', title: '元' });
    const actual = card('alpha', { created: '2026-09-01T00:00:00.000Z', title: '別' });

    expect(compareMigratedCards([expected], [actual])).toEqual(['alpha: title が一致しません']);
  });
});
