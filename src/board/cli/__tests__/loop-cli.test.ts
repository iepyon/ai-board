import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GitDocumentStore } from '../../../infrastructure/git-document-store.js';
import {
  createGitStoreFixture,
  initializedStore,
  type GitStoreFixture,
} from '../../../__tests__/git-store-fixture.js';
import { LOOP_COLLECTION, readLoopSteps } from '../../repositories/loop-history.repository.js';
import type { LoopStep } from '../../models/loop-step.js';
import { parseFlags, runLoopCli } from '../loop-cli.js';

// ============================================================
// 一時の git の置き場所で確かめる。ループの記録は手元（localDir）に置き、置き場所にはコミットしない
// ============================================================

let fixture: GitStoreFixture;
/** 置き場所を始めた後のコミット。ループの記録はこれを増やさない */
let commits: string[];
let stdout: string;
let stderr: string;
let now: Date;

/** 呼び出しごとに新しく組み、読み込む（別のプロセスとして走らせるのと同じ） */
async function openStore(): Promise<GitDocumentStore> {
  const store = fixture.open();
  await store.check();
  return store;
}

async function steps(): Promise<LoopStep[]> {
  return readLoopSteps(await openStore());
}

/** 手元に書いたループの記録のファイル */
function localLoopFiles(): string[] {
  const dir = path.join(fixture.localDir, LOOP_COLLECTION);
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

async function run(...argv: string[]): Promise<number> {
  // カードは `card-a` だけがあることにする。カードのリポジトリの書き込みの口は渡さない
  return runLoopCli(
    argv,
    { store: await openStore(), cardExists: (id) => Promise.resolve(id === 'card-a') },
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      now: () => now,
    }
  );
}

beforeEach(async () => {
  fixture = createGitStoreFixture();
  await initializedStore(fixture);
  commits = fixture.commitSubjects();

  stdout = '';
  stderr = '';
  now = new Date('2026-11-02T11:14:06.000Z');
});

afterEach(() => {
  fixture.remove();
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

const FINISH = ['finish', '--loop', 'session-a', '--card', 'card-a', '--result', 'advanced'];

describe('start と finish', () => {
  it('開始と終了を手元の 1 つの記録に書き、置き場所にはコミットしない', async () => {
    expect(await run(...START)).toBe(0);
    now = new Date('2026-11-02T11:15:41.000Z');
    expect(await run(...FINISH)).toBe(0);

    expect(fixture.commitSubjects()).toEqual(commits);
    expect(localLoopFiles()).toEqual(['20261102T111406.000Z.session-a.json']);
    expect(await steps()).toEqual([
      {
        loop: 'session-a',
        cardId: 'card-a',
        action: 'implement',
        step: 'task',
        agent: 'board-worker-card-a-1114',
        startedAt: '2026-11-02T11:14:06.000Z',
        finishedAt: '2026-11-02T11:15:41.000Z',
        result: 'advanced',
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
      await run('start', '--loop', 'session-a', '--card', 'card-a', '--action', 'revise-plan')
    ).toBe(0);

    expect((await steps()).map((s) => s.result)).toEqual(['interrupted', null]);
    expect(stderr).toContain('途切れた');
    expect(localLoopFiles()).toHaveLength(2);
    expect(fixture.commitSubjects()).toEqual(commits);
  });

  it.each(['revise-impl', 'ready'])(
    'start は廃止した手（%s）を受け付けず、何も書かない',
    async (action) => {
      expect(
        await run('start', '--loop', 'session-a', '--card', 'card-a', '--action', action)
      ).toBe(1);
      expect(stderr).toContain('--action には plan / revise-plan / implement');
      expect(await steps()).toEqual([]);
    }
  );
});

describe('拒否（何も書かない）', () => {
  async function expectRefused(argv: string[], message: string): Promise<void> {
    const before = localLoopFiles();
    const written = JSON.stringify(await steps());
    expect(await run(...argv)).toBe(1);
    expect(stderr).toContain(message);
    expect(localLoopFiles()).toEqual(before);
    expect(JSON.stringify(await steps())).toBe(written);
    expect(fixture.commitSubjects()).toEqual(commits);
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

  it('不正な結果・知らないオプション', async () => {
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
        '1',
      ],
      '不明なオプションです: --tokens'
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
