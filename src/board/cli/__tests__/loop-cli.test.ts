import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCliRunner } from '../../../infrastructure/cli-runner.js';
import { createDataStore, DATA_BRANCH } from '../../../infrastructure/data-store.js';
import { LOOP_DIR, readLoopSteps } from '../../repositories/loop-history.repository.js';
import { parseFlags, runLoopCli, type LoopCliDependencies } from '../loop-cli.js';

// ============================================================
// 一時ディレクトリの bare リポジトリを origin にした clone で、本物の git を通して確かめる
// ============================================================

let tmp: string;
let origin: string;
let dataDir: string;
let stdout: string;
let stderr: string;
let now: Date;

const runner = createCliRunner({ timeoutMs: 30_000 });

vi.setConfig({ testTimeout: 30_000 });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function originLog(): string[] {
  return git(origin, 'log', '--format=%s', DATA_BRANCH).split('\n');
}

function originFiles(): string[] {
  return git(origin, 'ls-tree', '-r', '--name-only', DATA_BRANCH).split('\n');
}

/** カードは `card-a` だけがあることにする。カードのリポジトリの書き込みの口は渡さない */
function deps(): LoopCliDependencies {
  return {
    store: createDataStore({ dataDir, runner, lockPollMs: 10 }),
    cardExists: (id) => Promise.resolve(id === 'card-a'),
  };
}

async function run(...argv: string[]): Promise<number> {
  return runLoopCli(argv, deps(), {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    now: () => now,
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-loop-cli-'));

  const globalConfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_AUTHOR_NAME', 'ai-board');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'ai-board@example.com');
  vi.stubEnv('GIT_COMMITTER_NAME', 'ai-board');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'ai-board@example.com');

  origin = path.join(tmp, 'origin.git');
  execFileSync('git', ['init', '--quiet', '--bare', origin]);

  const seed = path.join(tmp, 'seed');
  execFileSync('git', ['clone', '--quiet', origin, seed], { stdio: 'ignore' });
  git(seed, 'checkout', '--quiet', '--orphan', DATA_BRANCH);
  fs.writeFileSync(path.join(seed, 'ai-board-data.yaml'), 'version: 1\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '--quiet', '-m', 'data: 始める');
  git(seed, 'push', '--quiet', 'origin', `HEAD:refs/heads/${DATA_BRANCH}`);

  fs.mkdirSync(path.join(tmp, 'a'));
  dataDir = path.join(tmp, 'a', 'data');
  execFileSync('git', ['clone', '--quiet', '--branch', DATA_BRANCH, origin, dataDir]);

  stdout = '';
  stderr = '';
  now = new Date('2026-11-02T11:14:06.000Z');
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const START = [
  'start',
  '--loop',
  'session-a',
  '--card',
  'card-a',
  '--action',
  'implement',
  '--step',
  'task',
  '--agent',
  'board-worker-card-a-1114',
];

const FINISH = [
  'finish',
  '--loop',
  'session-a',
  '--card',
  'card-a',
  '--result',
  'advanced',
  '--tokens',
  '81234',
  '--duration-ms',
  '95000',
];

describe('start と finish', () => {
  it('開始と終了をそれぞれ 1 コミットにして push する。loop/ だけを書く', async () => {
    expect(await run(...START)).toBe(0);
    now = new Date('2026-11-02T11:15:41.000Z');
    expect(await run(...FINISH)).toBe(0);

    expect(originLog()).toEqual([
      'loop: finish card-a implement',
      'loop: start card-a implement',
      'data: 始める',
    ]);
    expect(originFiles()).toEqual([
      'ai-board-data.yaml',
      `${LOOP_DIR}/20261102T111406.000Z.session-a.json`,
    ]);
    expect(readLoopSteps(dataDir)).toEqual([
      {
        loop: 'session-a',
        cardId: 'card-a',
        action: 'implement',
        step: 'task',
        agent: 'board-worker-card-a-1114',
        startedAt: '2026-11-02T11:14:06.000Z',
        finishedAt: '2026-11-02T11:15:41.000Z',
        result: 'advanced',
        tokens: 81234,
        durationMs: 95000,
      },
    ]);
    expect(stdout).toBe(
      'session-a card-a implement（task）\nsession-a card-a implement（task） → advanced\n'
    );
    expect(stderr).toBe('');
  });

  it('同じループで start を続けると、前の記録を interrupted で閉じ、知らせる', async () => {
    expect(await run(...START)).toBe(0);
    now = new Date('2026-11-02T11:20:00.000Z');
    expect(
      await run('start', '--loop', 'session-a', '--card', 'card-a', '--action', 'revise-impl')
    ).toBe(0);

    expect(readLoopSteps(dataDir).map((s) => s.result)).toEqual(['interrupted', null]);
    expect(stderr).toContain('途切れた');
    expect(originLog()[0]).toBe('loop: start card-a revise-impl');
  });

  it('トークンと時間は省略できる', async () => {
    await run(...START);
    expect(
      await run('finish', '--loop', 'session-a', '--card', 'card-a', '--result', 'unknown')
    ).toBe(0);
    expect(readLoopSteps(dataDir)[0]).toMatchObject({
      result: 'unknown',
      tokens: null,
      durationMs: null,
    });
  });
});

describe('拒否（何も書かない）', () => {
  async function expectRefused(argv: string[], message: string): Promise<void> {
    const before = originLog();
    expect(await run(...argv)).toBe(1);
    expect(stderr).toContain(message);
    expect(originLog()).toEqual(before);
    expect(git(dataDir, 'status', '--porcelain')).toBe('');
  }

  it('存在しないカード', async () => {
    await expectRefused(
      ['start', '--loop', 'session-a', '--card', 'nope', '--action', 'plan'],
      'カードが見つかりません: nope'
    );
  });

  it('不正な手・段・識別子', async () => {
    await expectRefused(
      ['start', '--loop', 'session-a', '--card', 'card-a', '--action', 'foo'],
      '--action には'
    );
    await expectRefused(
      ['start', '--loop', 'session-a', '--card', 'card-a', '--action', 'implement', '--step', 'x'],
      '--step には'
    );
    await expectRefused(
      ['start', '--loop', 'session-a', '--card', 'card-a', '--action', 'plan', '--step', 'task'],
      '--action implement のときだけ'
    );
    await expectRefused(
      ['start', '--loop', '../x', '--card', 'card-a', '--action', 'plan'],
      '--loop には'
    );
    await expectRefused(['start', '--card', 'card-a', '--action', 'plan'], '--loop には');
  });

  it('不正な結果・整数でないトークンと時間', async () => {
    await run(...START);
    await expectRefused(
      ['finish', '--loop', 'session-a', '--card', 'card-a', '--result', 'interrupted'],
      '--result には'
    );
    await expectRefused(
      [
        'finish',
        '--loop',
        'session-a',
        '--card',
        'card-a',
        '--result',
        'advanced',
        '--tokens',
        '1.5',
      ],
      '--tokens には'
    );
    await expectRefused(
      [
        'finish',
        '--loop',
        'session-a',
        '--card',
        'card-a',
        '--result',
        'advanced',
        '--duration-ms',
        '-1',
      ],
      '--duration-ms には'
    );
  });

  it('終わっていない記録が無い', async () => {
    await expectRefused(FINISH, '終わっていない記録がありません');
    await run(...START);
    stderr = '';
    await run(...FINISH);
    await expectRefused(FINISH, '終わっていない記録がありません');
  });

  it('--card が食い違う', async () => {
    await run(...START);
    await expectRefused(
      ['finish', '--loop', 'session-a', '--card', 'card-b', '--result', 'advanced'],
      'card-a のものです'
    );
  });
});

describe('使い方', () => {
  it('引数なしと --help は使い方を出して 0、知らないコマンドは 1', async () => {
    expect(await run()).toBe(0);
    expect(await run('--help')).toBe(0);
    expect(await run('delete')).toBe(1);
    expect(stderr).toContain('使い方: ai-board loop');
  });

  it('知らないフラグ・位置引数・重複・値の無いフラグを拒む', () => {
    expect(parseFlags(['--x', '1'], ['--loop'])).toBe('不明なオプションです: --x');
    expect(parseFlags(['card-a'], ['--loop'])).toBe('余分な引数です: card-a');
    expect(parseFlags(['--loop', 'a', '--loop', 'b'], ['--loop'])).toBe(
      '--loop が 2 回指定されています'
    );
    expect(parseFlags(['--loop'], ['--loop'])).toBe('--loop には値を指定してください');
  });
});
