import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isErr } from '../../../shared/result.js';
import type { LoopStep } from '../../../shared/loop-step.js';
import {
  LOOP_DIR,
  LOOP_VOCABULARY_IN_SYNC,
  createFileLoopHistoryRepository,
  loopFileName,
  parseLoopFileName,
  parseLoopStep,
  readLoopSteps,
  serializeLoopStep,
  writeLoopFinish,
  writeLoopStart,
  type LoopStartInput,
} from '../loop-history.repository.js';

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-loop-history-'));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const START: LoopStartInput = {
  loop: 'session-a',
  cardId: 'card-a',
  action: 'implement',
  step: 'task',
  agent: 'board-worker-card-a-1114',
  startedAt: '2026-11-02T11:14:06.000Z',
};

function loopFiles(): string[] {
  return fs.readdirSync(path.join(dataDir, LOOP_DIR)).sort();
}

function readFile(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(dataDir, LOOP_DIR, name), 'utf-8'));
}

function writeRaw(name: string, content: string): void {
  fs.mkdirSync(path.join(dataDir, LOOP_DIR), { recursive: true });
  fs.writeFileSync(path.join(dataDir, LOOP_DIR, name), content);
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`失敗した: ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('手と段の値の一覧', () => {
  it('次の一手の型と食い違わない（食い違えば型エラーになる）', () => {
    expect(LOOP_VOCABULARY_IN_SYNC).toBe(true);
  });
});

describe('ファイル名', () => {
  it('開始の時刻と識別子から作り、読んで戻せる', () => {
    const name = loopFileName('2026-11-02T11:14:06.000Z', 'session-a', new Set());
    expect(name).toBe('20261102T111406.000Z.session-a.json');
    expect(parseLoopFileName(name ?? '')).toEqual({
      at: '2026-11-02T11:14:06.000Z',
      tail: 'session-a',
    });
  });

  it('同じ名前があれば連番を付ける', () => {
    const taken = new Set([
      '20261102T111406.000Z.session-a.json',
      '20261102T111406.000Z.session-a-2.json',
    ]);
    expect(loopFileName('2026-11-02T11:14:06.000Z', 'session-a', taken)).toBe(
      '20261102T111406.000Z.session-a-3.json'
    );
  });

  it('時刻として読めなければ null', () => {
    expect(loopFileName('not a date', 'session-a', new Set())).toBeNull();
    expect(parseLoopFileName('20261302T111406.000Z.session-a.json')).toBeNull();
    expect(parseLoopFileName('20261102T111406.000Z.session-a.md')).toBeNull();
    expect(parseLoopFileName('x.json')).toBeNull();
  });
});

describe('中身', () => {
  it('書いて読み戻せる', () => {
    const step: LoopStep = {
      ...START,
      finishedAt: '2026-11-02T11:31:40.000Z',
      result: 'advanced',
      tokens: 412345,
      durationMs: 1054000,
    };
    expect(parseLoopStep(JSON.parse(serializeLoopStep(step)))).toEqual(step);
  });

  it('終了の時刻と結果の片方だけが埋まっていれば読まない', () => {
    expect(
      parseLoopStep({
        ...START,
        finishedAt: '2026-11-02T11:31:40.000Z',
        result: null,
        tokens: null,
        durationMs: null,
      })
    ).toBeNull();
  });

  it('廃止した手（revise-impl / ready）の過去の記録も読める', () => {
    const base = {
      ...START,
      step: null,
      finishedAt: null,
      result: null,
      tokens: null,
      durationMs: null,
    };
    expect(parseLoopStep({ ...base, action: 'revise-impl' })?.action).toBe('revise-impl');
    expect(parseLoopStep({ ...base, action: 'ready' })?.action).toBe('ready');
  });

  it('規定外の手・不正な識別子・負のトークンは読まない', () => {
    const base = { ...START, finishedAt: null, result: null, tokens: null, durationMs: null };
    expect(parseLoopStep({ ...base, action: 'foo' })).toBeNull();
    expect(parseLoopStep({ ...base, loop: '../x' })).toBeNull();
    expect(parseLoopStep({ ...base, tokens: -1 })).toBeNull();
  });
});

describe('writeLoopStart', () => {
  it('終わっていない記録を作る', () => {
    const outcome = unwrap(writeLoopStart(dataDir, START));

    expect(outcome.interrupted).toEqual([]);
    expect(loopFiles()).toEqual(['20261102T111406.000Z.session-a.json']);
    expect(readFile('20261102T111406.000Z.session-a.json')).toEqual({
      loop: 'session-a',
      cardId: 'card-a',
      action: 'implement',
      step: 'task',
      agent: 'board-worker-card-a-1114',
      startedAt: '2026-11-02T11:14:06.000Z',
      finishedAt: null,
      result: null,
      tokens: null,
      durationMs: null,
    });
  });

  it('同じループの終わっていない記録を interrupted で閉じてから作る。ほかのループの記録には触らない', () => {
    unwrap(writeLoopStart(dataDir, START));
    unwrap(
      writeLoopStart(dataDir, {
        ...START,
        loop: 'session-b',
        startedAt: '2026-11-02T11:15:00.000Z',
      })
    );

    const outcome = unwrap(
      writeLoopStart(dataDir, {
        ...START,
        action: 'plan',
        step: null,
        startedAt: '2026-11-02T11:20:00.000Z',
      })
    );

    expect(outcome.interrupted).toHaveLength(1);
    expect(readFile('20261102T111406.000Z.session-a.json')).toMatchObject({
      result: 'interrupted',
      finishedAt: '2026-11-02T11:20:00.000Z',
    });
    expect(readFile('20261102T111500.000Z.session-b.json')).toMatchObject({ result: null });
    expect(readFile('20261102T112000.000Z.session-a.json')).toMatchObject({
      action: 'plan',
      result: null,
    });
  });

  it('同じ時刻と識別子が重なれば連番のファイルにする', () => {
    unwrap(writeLoopStart(dataDir, START));
    unwrap(writeLoopStart(dataDir, START));

    expect(loopFiles()).toEqual([
      '20261102T111406.000Z.session-a-2.json',
      '20261102T111406.000Z.session-a.json',
    ]);
    // 連番のファイルも、識別子が `-` を含んでいても読める
    expect(readLoopSteps(dataDir)).toHaveLength(2);
  });

  it('時刻がファイル名にできなければ拒んで何も書かない', () => {
    const result = writeLoopStart(dataDir, { ...START, startedAt: 'nope' });
    expect(isErr(result) && result.error.type).toBe('InvalidLoopTime');
    expect(fs.existsSync(path.join(dataDir, LOOP_DIR))).toBe(false);
  });
});

describe('writeLoopFinish', () => {
  const FINISH = {
    loop: 'session-a',
    cardId: 'card-a',
    result: 'advanced' as const,
    tokens: 81234,
    durationMs: 95000,
    finishedAt: '2026-11-02T11:31:40.000Z',
  };

  it('そのループの終わっていない記録を埋める', () => {
    unwrap(writeLoopStart(dataDir, START));
    const finished = unwrap(writeLoopFinish(dataDir, FINISH));

    expect(finished).toMatchObject({ result: 'advanced', tokens: 81234, durationMs: 95000 });
    expect(readFile('20261102T111406.000Z.session-a.json')).toMatchObject({
      finishedAt: '2026-11-02T11:31:40.000Z',
      result: 'advanced',
    });
  });

  it('時間が null なら、開始から終了までのミリ秒で埋める', () => {
    unwrap(writeLoopStart(dataDir, START));
    const finished = unwrap(
      writeLoopFinish(dataDir, { ...FINISH, tokens: null, durationMs: null })
    );

    // 11:14:06 から 11:31:40 まで
    expect(finished).toMatchObject({ tokens: null, durationMs: 1054000 });
  });

  it('終了が開始より前（時計の戻り）なら、時間は 0 にする', () => {
    unwrap(writeLoopStart(dataDir, START));
    const finished = unwrap(
      writeLoopFinish(dataDir, {
        ...FINISH,
        durationMs: null,
        finishedAt: '2026-11-02T11:14:00.000Z',
      })
    );

    expect(finished.durationMs).toBe(0);
  });

  it('終わった記録は書き換えない。2 度目の終了は終わっていない記録が無いので拒む', () => {
    unwrap(writeLoopStart(dataDir, START));
    unwrap(writeLoopFinish(dataDir, FINISH));
    const before = fs.readFileSync(
      path.join(dataDir, LOOP_DIR, '20261102T111406.000Z.session-a.json'),
      'utf-8'
    );

    const again = writeLoopFinish(dataDir, { ...FINISH, result: 'stopped' });
    expect(isErr(again) && again.error.type).toBe('NoRunningLoopStep');

    // 開始も、終わった記録を interrupted で閉じ直さない
    unwrap(writeLoopStart(dataDir, { ...START, startedAt: '2026-11-02T12:00:00.000Z' }));
    expect(
      fs.readFileSync(path.join(dataDir, LOOP_DIR, '20261102T111406.000Z.session-a.json'), 'utf-8')
    ).toBe(before);
  });

  it('カードが食い違えば拒んで何も書かない', () => {
    unwrap(writeLoopStart(dataDir, START));
    const result = writeLoopFinish(dataDir, { ...FINISH, cardId: 'card-b' });

    expect(isErr(result) && result.error).toEqual({
      type: 'RunningLoopStepCardMismatch',
      loop: 'session-a',
      running: 'card-a',
      given: 'card-b',
    });
    expect(readFile('20261102T111406.000Z.session-a.json')).toMatchObject({ result: null });
  });

  it('ほかのループの終わっていない記録は埋めない', () => {
    unwrap(writeLoopStart(dataDir, START));
    const result = writeLoopFinish(dataDir, { ...FINISH, loop: 'session-b' });
    expect(isErr(result) && result.error.type).toBe('NoRunningLoopStep');
  });
});

describe('読み出し', () => {
  it('開始の時刻の順に返し、読めないファイルは警告して飛ばす', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    unwrap(writeLoopStart(dataDir, { ...START, loop: 'b', startedAt: '2026-11-02T12:00:00.000Z' }));
    unwrap(writeLoopStart(dataDir, { ...START, loop: 'a' }));
    writeRaw('20261102T130000.000Z.c.json', '{ not json');
    writeRaw('readme.txt', 'x');
    // ファイル名の時刻と中身の時刻が食い違う
    writeRaw(
      '20261102T140000.000Z.a.json',
      serializeLoopStep({
        ...START,
        loop: 'a',
        finishedAt: null,
        result: null,
        tokens: null,
        durationMs: null,
      })
    );
    // ファイル名の識別子と中身の識別子が食い違う
    writeRaw(
      '20261102T111406.000Z.zzz.json',
      serializeLoopStep({
        ...START,
        loop: 'a',
        finishedAt: null,
        result: null,
        tokens: null,
        durationMs: null,
      })
    );

    const steps = await createFileLoopHistoryRepository(dataDir).findAll();

    expect(steps.map((s) => s.loop)).toEqual(['a', 'b']);
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it('loop/ が無ければ空', () => {
    expect(readLoopSteps(dataDir)).toEqual([]);
  });
});

// ============================================================
// 形の版を上げない前提: DATA_PATHS に loop を持たない古い CLI の書き込みでも loop/ は残る
// ============================================================

describe('古い CLI の書き込み', () => {
  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  let globalConfig: string;

  beforeEach(() => {
    // 利用者の git の設定（署名など）に左右されないよう、空の設定と名前を与える。dataDir の外に置く
    globalConfig = `${dataDir}.gitconfig`;
    fs.writeFileSync(globalConfig, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
    vi.stubEnv('GIT_AUTHOR_NAME', 'ai-board');
    vi.stubEnv('GIT_AUTHOR_EMAIL', 'ai-board@example.com');
    vi.stubEnv('GIT_COMMITTER_NAME', 'ai-board');
    vi.stubEnv('GIT_COMMITTER_EMAIL', 'ai-board@example.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(globalConfig, { force: true });
  });

  it('loop を除いた add・clean・reset の後も、追跡済みの loop/ のファイルは消えない', () => {
    git(dataDir, 'init', '--quiet', '--initial-branch', 'ai-board/data');
    fs.writeFileSync(path.join(dataDir, 'ai-board-data.yaml'), 'version: 1\n');
    unwrap(writeLoopStart(dataDir, START));
    git(dataDir, 'add', '-A');
    git(dataDir, 'commit', '--quiet', '-m', 'loop: start card-a implement');

    // 古い CLI の DATA_PATHS（loop を持たない）で、カードを書いてコミットする道をなぞる
    const oldPaths = ['cards', 'order.yaml', 'snapshots', 'ai-board-data.yaml', 'config.yaml'];
    git(dataDir, 'reset', '--hard', '--quiet', 'HEAD');
    git(dataDir, 'clean', '-fdq');
    git(dataDir, 'clean', '-fdqx', '--', ...oldPaths);
    fs.mkdirSync(path.join(dataDir, 'cards', 'card-a'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'cards', 'card-a', 'card.md'), '---\nid: card-a\n---\n');
    const present = oldPaths.filter((p) => fs.existsSync(path.join(dataDir, p)));
    git(dataDir, 'add', '--all', '--force', '--', ...present);
    git(dataDir, 'add', '--update');
    git(dataDir, 'commit', '--quiet', '--no-verify', '-m', 'data: card-a を書く');
    git(dataDir, 'reset', '--hard', '--quiet', 'HEAD');
    git(dataDir, 'clean', '-fdq');
    git(dataDir, 'clean', '-fdqx', '--', ...oldPaths);

    expect(git(dataDir, 'ls-tree', '-r', '--name-only', 'HEAD').split('\n')).toContain(
      `${LOOP_DIR}/20261102T111406.000Z.session-a.json`
    );
    expect(readLoopSteps(dataDir)).toHaveLength(1);
  });
});
