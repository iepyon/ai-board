import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { ok, err } from '../../shared/result.js';
import type { CliRunner } from '../cli-runner.js';
import {
  DIST_CHECK_FAILED,
  DIST_CHECK_FRESH,
  DIST_CHECK_STALE,
  runDistCheckCli,
} from '../dist-check-cli.js';

const ROOT = '/repo';
const DIST = path.join(ROOT, 'dist', 'cli.js');

function setup(options: { mtimeMs: number | null; log: ReturnType<CliRunner['run']> }) {
  const calls: { command: string; args: readonly string[] }[] = [];
  const out: string[] = [];
  const errOut: string[] = [];
  const runner: CliRunner = {
    run: (command, args) => {
      calls.push({ command, args });
      return options.log;
    },
  };
  const mtimeFiles: string[] = [];
  const deps = {
    root: ROOT,
    runner,
    mtimeMs: (file: string) => {
      mtimeFiles.push(file);
      return options.mtimeMs;
    },
  };
  const io = { stdout: (t: string) => out.push(t), stderr: (t: string) => errOut.push(t) };
  return { deps, io, calls, out, errOut, mtimeFiles };
}

describe('runDistCheckCli', () => {
  it('dist/cli.js が HEAD のコミットより新しければ 0', async () => {
    const s = setup({ mtimeMs: 2_000_000, log: Promise.resolve(ok('1999\n')) });

    expect(await runDistCheckCli([], s.deps, s.io)).toBe(DIST_CHECK_FRESH);
    expect(s.mtimeFiles).toEqual([DIST]);
    expect(s.calls).toEqual([{ command: 'git', args: ['-C', ROOT, 'log', '-1', '--format=%ct'] }]);
  });

  it('同じ秒なら新しいとみなす', async () => {
    const s = setup({ mtimeMs: 2_000_500, log: Promise.resolve(ok('2000\n')) });

    expect(await runDistCheckCli([], s.deps, s.io)).toBe(DIST_CHECK_FRESH);
  });

  it('HEAD のコミットより古ければ 1', async () => {
    const s = setup({ mtimeMs: 1_999_000, log: Promise.resolve(ok('2000\n')) });

    expect(await runDistCheckCli([], s.deps, s.io)).toBe(DIST_CHECK_STALE);
    expect(s.out.join('')).toContain('古い');
  });

  it('dist/cli.js が無ければ git を呼ばずに 1', async () => {
    const s = setup({ mtimeMs: null, log: Promise.resolve(ok('2000\n')) });

    expect(await runDistCheckCli([], s.deps, s.io)).toBe(DIST_CHECK_STALE);
    expect(s.calls).toEqual([]);
  });

  it('git が失敗したら 2', async () => {
    const s = setup({
      mtimeMs: 2_000_000,
      log: Promise.resolve(
        err({
          type: 'Failed',
          command: 'git',
          message: '終了コード 128 で失敗した',
          httpStatus: null,
        })
      ),
    });

    expect(await runDistCheckCli([], s.deps, s.io)).toBe(DIST_CHECK_FAILED);
    expect(s.errOut.join('')).toContain('HEAD のコミット時刻を読めませんでした');
  });

  it.each(['', 'abc\n'])('git の出力が数でなければ 2（%j）', async (stdout) => {
    const s = setup({ mtimeMs: 2_000_000, log: Promise.resolve(ok(stdout)) });

    expect(await runDistCheckCli([], s.deps, s.io)).toBe(DIST_CHECK_FAILED);
  });

  it('不明な引数は 2 で、何も読まない', async () => {
    const s = setup({ mtimeMs: 2_000_000, log: Promise.resolve(ok('1\n')) });

    expect(await runDistCheckCli(['--json'], s.deps, s.io)).toBe(DIST_CHECK_FAILED);
    expect(s.calls).toEqual([]);
    expect(s.mtimeFiles).toEqual([]);
  });

  it('--help は使い方を出して 0', async () => {
    const s = setup({ mtimeMs: null, log: Promise.resolve(ok('1\n')) });

    expect(await runDistCheckCli(['--help'], s.deps, s.io)).toBe(DIST_CHECK_FRESH);
    expect(s.out.join('')).toContain('使い方: ai-board dist-check');
  });
});
