import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CliError, CliRunner } from '../../../infrastructure/cli-runner.js';
import type { ForgeConfig } from '../../../infrastructure/config.js';
import { err, ok, type Result } from '../../../shared/result.js';
import { isPrCommand, runPrCli } from '../pr-cli.js';
import { CLAUDE_CODE_FOOTER } from '../../services/github-client.js';

// ============================================================
// 偽の gh
// ============================================================

const forge: ForgeConfig = { kind: 'github', owner: 'iepyon', repo: 'ai-board' };

interface Call {
  readonly command: string;
  readonly args: readonly string[];
  /** `--input` で渡されたファイルの中身（JSON）。呼ばれた時点で読む（呼んだ後に消されるため） */
  readonly input: unknown;
  readonly inputPath: string | null;
}

type Responder = (args: readonly string[]) => Result<string, CliError>;

function fakeRunner(respond: Responder): { runner: CliRunner; calls: Call[] } {
  const calls: Call[] = [];

  const runner: CliRunner = {
    run: async (command, args) => {
      const index = args.indexOf('--input');
      const inputPath = index === -1 ? null : (args[index + 1] ?? null);
      const input = inputPath === null ? null : JSON.parse(readFileSync(inputPath, 'utf-8'));
      calls.push({ command, args: [...args], input, inputPath });

      return respond(args);
    },
  };

  return { runner, calls };
}

function failed(httpStatus: number | null): Result<string, CliError> {
  return err({ type: 'Failed', command: 'gh', message: '終了コード 1 で失敗した', httpStatus });
}

function json(value: unknown): Result<string, CliError> {
  return ok(JSON.stringify(value));
}

let tmp: string;
let stdout: string;
let stderr: string;
const io = {
  stdout: (text: string) => {
    stdout += text;
  },
  stderr: (text: string) => {
    stderr += text;
  },
};

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-pr-cli-'));
  stdout = '';
  stderr = '';
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function bodyFile(content: string): Promise<string> {
  const file = path.join(tmp, 'body.md');
  await fs.writeFile(file, content, 'utf-8');
  return file;
}

const BODY = '## 概要\n\n計画は `.ai-board/plans/x.md` にある。\n';

const pr = {
  number: 7,
  state: 'open',
  merged_at: null,
  draft: true,
  head: { ref: 'issue-store', sha: 'deadbeef' },
  base: { ref: 'main' },
  title: 'カードを git に移す',
  html_url: 'https://github.com/iepyon/ai-board/pull/7',
  body: BODY,
  user: { login: 'iepyon' },
};

// ============================================================
// create
// ============================================================

describe('ai-board pr create', () => {
  it('本文を引数に載せず、送る項目をすべて --input の JSON に入れて POST pulls する', async () => {
    const file = await bodyFile(BODY);
    const { runner, calls } = fakeRunner(() =>
      json({ number: 12, html_url: 'https://github.com/iepyon/ai-board/pull/12' })
    );

    const code = await runPrCli(
      [
        'create',
        '--draft',
        '--head',
        'issue-store',
        '--base',
        'main',
        '--title',
        '計画',
        '--body-file',
        file,
      ],
      { forge, runner },
      io
    );

    expect(code).toBe(0);
    expect(stdout).toBe('#12 https://github.com/iepyon/ai-board/pull/12\n');
    expect(calls).toHaveLength(1);

    const call = calls[0];
    expect(call?.command).toBe('gh');
    expect(call?.args).toEqual([
      'api',
      '--method',
      'POST',
      'repos/iepyon/ai-board/pulls',
      '--input',
      call?.inputPath,
    ]);
    expect(call?.input).toEqual({
      title: '計画',
      head: 'issue-store',
      base: 'main',
      body: BODY,
      draft: true,
    });
    expect(call?.args.join(' ')).not.toContain('概要');
  });

  it('--input の一時ファイルは作業ディレクトリの外に作り、送った後に消す', async () => {
    const file = await bodyFile(BODY);
    const { runner, calls } = fakeRunner(() => json({ number: 12, html_url: 'u' }));

    await runPrCli(
      ['create', '--head', 'b', '--base', 'main', '--title', 't', '--body-file', file],
      { forge, runner },
      io
    );

    const inputPath = calls[0]?.inputPath ?? '';
    expect(inputPath.startsWith(os.tmpdir())).toBe(true);
    expect(existsSync(inputPath)).toBe(false);
  });

  it('--base が無ければリポジトリの既定のブランチへ向け、--draft が無ければ Draft にしない', async () => {
    const file = await bodyFile(BODY);
    const { runner, calls } = fakeRunner((args) =>
      args[1] === 'repos/iepyon/ai-board'
        ? json({ default_branch: 'trunk' })
        : json({ number: 3, html_url: 'u' })
    );

    const code = await runPrCli(
      ['create', '--head', 'b', '--title', 't', '--body-file', file],
      { forge, runner },
      io
    );

    expect(code).toBe(0);
    expect(calls[0]?.args).toEqual(['api', 'repos/iepyon/ai-board']);
    expect(calls[1]?.input).toMatchObject({ base: 'trunk', draft: false });
  });

  it('作れなければ HTTP のステータスを添えて失敗する', async () => {
    const file = await bodyFile(BODY);
    const { runner } = fakeRunner(() => failed(422));

    const code = await runPrCli(
      ['create', '--head', 'b', '--base', 'main', '--title', 't', '--body-file', file],
      { forge, runner },
      io
    );

    expect(code).toBe(1);
    expect(stderr).toContain('PR を作れませんでした');
    expect(stderr).toContain('HTTP 422');
  });

  it('--head・--title・--body-file のどれかが無ければ、gh を呼ばずに失敗する', async () => {
    const file = await bodyFile(BODY);
    const { runner, calls } = fakeRunner(() => json({}));

    expect(
      await runPrCli(['create', '--title', 't', '--body-file', file], { forge, runner }, io)
    ).toBe(1);
    expect(
      await runPrCli(['create', '--head', 'b', '--body-file', file], { forge, runner }, io)
    ).toBe(1);
    expect(await runPrCli(['create', '--head', 'b', '--title', 't'], { forge, runner }, io)).toBe(
      1
    );
    expect(calls).toHaveLength(0);
  });

  it('--body-file のファイルが読めなければ、gh を呼ばずに失敗する', async () => {
    const { runner, calls } = fakeRunner(() => json({}));

    const code = await runPrCli(
      ['create', '--head', 'b', '--title', 't', '--body-file', path.join(tmp, 'missing.md')],
      { forge, runner },
      io
    );

    expect(code).toBe(1);
    expect(stderr).toContain('--body-file のファイルを読めません');
    expect(calls).toHaveLength(0);
  });
});

// ============================================================
// view
// ============================================================

describe('ai-board pr view', () => {
  it('GET pulls/<n> から題・状態・ブランチ・本文を出す', async () => {
    const { runner, calls } = fakeRunner(() => json(pr));

    const code = await runPrCli(['view', '7'], { forge, runner }, io);

    expect(code).toBe(0);
    expect(calls.map((call) => call.args)).toEqual([['api', 'repos/iepyon/ai-board/pulls/7']]);
    expect(stdout).toContain('#7 カードを git に移す');
    expect(stdout).toContain('状態: 開いている（Draft）');
    expect(stdout).toContain('ブランチ: issue-store → main');
    expect(stdout).toContain(BODY);
  });

  it('--body は本文だけをそのまま出す', async () => {
    const { runner } = fakeRunner(() => json(pr));

    const code = await runPrCli(['view', '7', '--body'], { forge, runner }, io);

    expect(code).toBe(0);
    expect(stdout).toBe(BODY);
  });

  it('--comments は issue comment と review comment を全ページ引き、時刻の順に出す', async () => {
    const { runner, calls } = fakeRunner((args) => {
      const target = args[args.length - 1] ?? '';
      if (target.includes('issues/7/comments')) {
        return json([
          {
            created_at: '2026-10-03T00:00:00Z',
            body: '後のコメント',
            html_url: 'https://github.com/iepyon/ai-board/pull/7#issuecomment-2',
            user: { login: 'iepyon' },
          },
        ]);
      }
      if (target.includes('pulls/7/comments')) {
        return json([
          {
            created_at: '2026-10-02T00:00:00Z',
            body: '行への指摘',
            html_url: 'https://github.com/iepyon/ai-board/pull/7#discussion_r1',
            user: { login: 'reviewer' },
            path: 'src/a.ts',
            line: 12,
          },
        ]);
      }
      return json(pr);
    });

    const code = await runPrCli(['view', '7', '--comments'], { forge, runner }, io);

    expect(code).toBe(0);
    expect(calls.map((call) => call.args)).toContainEqual([
      'api',
      '--paginate',
      'repos/iepyon/ai-board/issues/7/comments?per_page=100',
    ]);
    expect(calls.map((call) => call.args)).toContainEqual([
      'api',
      '--paginate',
      'repos/iepyon/ai-board/pulls/7/comments?per_page=100',
    ]);
    expect(stdout).toContain('## コメント（2 件）');
    expect(stdout).toContain('reviewer  2026-10-02T00:00:00Z  src/a.ts:12');
    expect(stdout.indexOf('行への指摘')).toBeLessThan(stdout.indexOf('後のコメント'));
  });

  it('--comments と --body を同時に指定すると、gh を呼ばずに失敗する', async () => {
    const { runner, calls } = fakeRunner(() => json(pr));

    const code = await runPrCli(['view', '7', '--comments', '--body'], { forge, runner }, io);

    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('PR が無ければ HTTP 404 を添えて失敗する', async () => {
    const { runner } = fakeRunner(() => failed(404));

    const code = await runPrCli(['view', '7'], { forge, runner }, io);

    expect(code).toBe(1);
    expect(stderr).toContain('PR #7 を読めませんでした');
    expect(stderr).toContain('HTTP 404');
  });
});

// ============================================================
// edit / comment / diff
// ============================================================

describe('ai-board pr edit', () => {
  it('本文を --input の JSON にして PATCH pulls/<n> する', async () => {
    const file = await bodyFile(BODY);
    const { runner, calls } = fakeRunner(() => json({ html_url: pr.html_url }));

    const code = await runPrCli(['edit', '7', '--body-file', file], { forge, runner }, io);

    expect(code).toBe(0);
    expect(stdout).toBe(`${pr.html_url}\n`);
    expect(calls[0]?.args.slice(0, 4)).toEqual([
      'api',
      '--method',
      'PATCH',
      'repos/iepyon/ai-board/pulls/7',
    ]);
    expect(calls[0]?.input).toEqual({ body: BODY });
  });
});

describe('ai-board pr comment', () => {
  it('本文を --input の JSON にして POST issues/<n>/comments する', async () => {
    const file = await bodyFile('判断してほしい点\n');
    const { runner, calls } = fakeRunner(() => json({ html_url: `${pr.html_url}#issuecomment-9` }));

    const code = await runPrCli(['comment', '7', '--body-file', file], { forge, runner }, io);

    expect(code).toBe(0);
    expect(stdout).toBe(`${pr.html_url}#issuecomment-9\n`);
    expect(calls[0]?.args.slice(0, 4)).toEqual([
      'api',
      '--method',
      'POST',
      'repos/iepyon/ai-board/issues/7/comments',
    ]);
    expect(calls[0]?.input).toEqual({
      body: `判断してほしい点\n\n---\n${CLAUDE_CODE_FOOTER}\n`,
    });
  });

  it('Claude Code のフッターが既にある本文は、そのまま送る', async () => {
    const body = `直すものはありません\n\n---\n${CLAUDE_CODE_FOOTER}\n`;
    const file = await bodyFile(body);
    const { runner, calls } = fakeRunner(() => json({ html_url: `${pr.html_url}#issuecomment-9` }));

    const code = await runPrCli(['comment', '7', '--body-file', file], { forge, runner }, io);

    expect(code).toBe(0);
    expect(calls[0]?.input).toEqual({ body });
  });
});

describe('ai-board pr diff', () => {
  it('diff の Accept で GET pulls/<n> し、応答をそのまま出す', async () => {
    const diff = 'diff --git a/x b/x\n+1\n';
    const { runner, calls } = fakeRunner(() => ok(diff));

    const code = await runPrCli(['diff', '7'], { forge, runner }, io);

    expect(code).toBe(0);
    expect(stdout).toBe(diff);
    expect(calls[0]?.args).toEqual([
      'api',
      '-H',
      'Accept: application/vnd.github.diff',
      'repos/iepyon/ai-board/pulls/7',
    ]);
  });
});

// ============================================================
// ready
// ============================================================

describe('ai-board pr ready', () => {
  const GH_READY = ['pr', 'ready', '7', '--repo', 'iepyon/ai-board'];
  const CCR_READY = [
    'api',
    '--method',
    'POST',
    'repos/iepyon/ai-board/pulls/7/ccr/ready_for_review',
  ];

  it('gh pr ready が通れば、ccr/ready_for_review は試さない', async () => {
    const { runner, calls } = fakeRunner(() => ok(''));

    const code = await runPrCli(['ready', '7'], { forge, runner }, io);

    expect(code).toBe(0);
    expect(calls.map((call) => call.args)).toEqual([GH_READY]);
    expect(stdout).toContain('gh pr ready');
  });

  it('gh pr ready が失敗したら ccr/ready_for_review を試す', async () => {
    const { runner, calls } = fakeRunner((args) => (args[0] === 'pr' ? failed(403) : ok('{}')));

    const code = await runPrCli(['ready', '7'], { forge, runner }, io);

    expect(code).toBe(0);
    expect(calls.map((call) => call.args)).toEqual([GH_READY, CCR_READY]);
    expect(stdout).toContain('ccr/ready_for_review');
  });

  it('どちらも失敗したら、両方の経路の理由を出して失敗する', async () => {
    const { runner } = fakeRunner((args) => (args[0] === 'pr' ? failed(403) : failed(404)));

    const code = await runPrCli(['ready', '7'], { forge, runner }, io);

    expect(code).toBe(1);
    expect(stderr).toContain('PR #7 を Ready にできませんでした');
    expect(stderr).toMatch(/gh pr ready: .*HTTP 403/);
    expect(stderr).toMatch(/ccr\/ready_for_review: .*HTTP 404/);
  });
});

// ============================================================
// 引数と設定
// ============================================================

describe('ai-board pr の引数と設定', () => {
  it.each([[['view']], [['view', 'abc']], [['view', '0']], [['view', '-1']], [['diff', '7', '8']]])(
    'PR の番号が無い・正の整数でない・余分にあるとき（%j）は、gh を呼ばずに失敗する',
    async (argv) => {
      const { runner, calls } = fakeRunner(() => json(pr));

      expect(await runPrCli(argv, { forge, runner }, io)).toBe(1);
      expect(calls).toHaveLength(0);
    }
  );

  it('コマンドが受け付けないオプションは、gh を呼ばずに失敗する', async () => {
    const { runner, calls } = fakeRunner(() => json(pr));

    expect(await runPrCli(['view', '7', '--json'], { forge, runner }, io)).toBe(1);
    expect(stderr).toContain('不明なオプションです: --json');
    expect(calls).toHaveLength(0);
  });

  it('config.yaml に github: が無ければ、gh を呼ばずに失敗する', async () => {
    const { runner, calls } = fakeRunner(() => json(pr));

    expect(await runPrCli(['view', '7'], { forge: null, runner }, io)).toBe(1);
    expect(stderr).toContain('github:');
    expect(calls).toHaveLength(0);
  });

  it('不明なコマンドは使い方を出して 1、--help は使い方を出して 0', async () => {
    const { runner, calls } = fakeRunner(() => json(pr));

    expect(await runPrCli(['merge', '7'], { forge, runner }, io)).toBe(1);
    expect(await runPrCli(['create', '--help'], { forge, runner }, io)).toBe(0);
    expect(stderr).toContain('使い方: ai-board pr');
    expect(calls).toHaveLength(0);
  });

  it('isPrCommand はコマンドの名前だけを真にする', () => {
    expect(isPrCommand('ready')).toBe(true);
    expect(isPrCommand('toString')).toBe(false);
    expect(isPrCommand(undefined)).toBe(false);
  });
});

describe('ai-board pr checks', () => {
  const SHA = 'abcdef1234567890';
  const pr = { number: 78, head: { ref: 'b', sha: SHA }, base: { ref: 'main' } };

  /** `check-runs` は `--jq` で 1 件 1 行になるので、行で返す */
  function lines(runs: readonly unknown[]): Result<string, CliError> {
    return ok(runs.map((r) => JSON.stringify(r)).join('\n') + (runs.length > 0 ? '\n' : ''));
  }

  const success = { name: 'test (24)', status: 'completed', conclusion: 'success', html_url: 'u1' };
  const running = { name: 'test (22)', status: 'in_progress', conclusion: null, html_url: 'u2' };
  const failure = { name: 'test (22)', status: 'completed', conclusion: 'failure', html_url: 'u3' };

  /** 呼ばれるたびに次の check-runs の組を返す（最後の組を使い回す） */
  function responder(
    sequence: readonly (readonly unknown[])[],
    statuses: readonly unknown[] = []
  ): Responder {
    let index = 0;
    return (args) => {
      const endpoint = args[args.length - 1] ?? '';
      if (endpoint.endsWith('/pulls/78')) return json(pr);
      if (endpoint.includes('/check-runs')) {
        const runs = sequence[Math.min(index, sequence.length - 1)] ?? [];
        index += 1;
        return lines(runs);
      }
      if (endpoint.includes(`/commits/${SHA}/status`)) return lines(statuses);
      return failed(404);
    };
  }

  /** 進めた時間だけ now が進む偽の時計 */
  function fakeClock(): {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    slept: number[];
  } {
    let t = 0;
    const slept: number[] = [];
    return {
      now: () => t,
      sleep: async (ms) => {
        slept.push(ms);
        t += ms;
      },
      slept,
    };
  }

  it('check-runs と status をまとめて出し、全部通っていれば 0 で終わる', async () => {
    const { runner, calls } = fakeRunner(
      responder([[success]], [{ context: 'ext', state: 'success', target_url: 'u9' }])
    );

    expect(await runPrCli(['checks', '78'], { forge, runner }, io)).toBe(0);
    expect(stdout).toContain('PR #78 の最新コミット abcdef1 のチェック: passed');
    expect(stdout).toContain('通った  test (24)  success  u1');
    expect(stdout).toContain('通った  ext（status）  success  u9');

    const runsCall = calls.find((c) => c.args.some((a) => a.includes('/check-runs')));
    expect(runsCall?.args).toEqual([
      'api',
      '--paginate',
      '--jq',
      '.check_runs[]',
      `repos/iepyon/ai-board/commits/${SHA}/check-runs?per_page=100`,
    ]);
  });

  it('落ちたものがあれば 1、走っているものがあれば 2 で終わる（--wait なしでは待たない）', async () => {
    expect(
      await runPrCli(
        ['checks', '78'],
        { forge, runner: fakeRunner(responder([[success, failure]])).runner },
        io
      )
    ).toBe(1);
    expect(stdout).toContain('落ちた  test (22)  failure  u3');

    const clock = fakeClock();
    expect(
      await runPrCli(
        ['checks', '78'],
        { forge, runner: fakeRunner(responder([[running]])).runner, clock },
        io
      )
    ).toBe(2);
    expect(clock.slept).toEqual([]);
  });

  it('チェックが無ければ none で 0 で終わる', async () => {
    expect(
      await runPrCli(['checks', '78'], { forge, runner: fakeRunner(responder([[]])).runner }, io)
    ).toBe(0);
    expect(stdout).toContain('チェックはありません');
  });

  it('--json は行と判定を JSON で出す', async () => {
    expect(
      await runPrCli(
        ['checks', '78', '--json'],
        { forge, runner: fakeRunner(responder([[success]])).runner },
        io
      )
    ).toBe(0);
    const parsed = JSON.parse(stdout) as {
      sha: string;
      verdict: string;
      timedOut: boolean;
      rows: unknown[];
    };
    expect(parsed).toMatchObject({ sha: SHA, verdict: 'passed', timedOut: false });
    expect(parsed.rows).toHaveLength(1);
  });

  it('--wait は走っている間 15 秒おきに引き直し、終わったら結果で終わる', async () => {
    const clock = fakeClock();
    const { runner } = fakeRunner(responder([[running], [running], [success]]));

    expect(await runPrCli(['checks', '78', '--wait'], { forge, runner, clock }, io)).toBe(0);
    expect(clock.slept).toEqual([15_000, 15_000]);
    expect(stdout).toContain('passed');
  });

  it('--wait は push の直後でチェックが無い間は猶予まで待ち、現れたら待ち続ける', async () => {
    const clock = fakeClock();
    const { runner } = fakeRunner(responder([[], [], [running], [failure]]));

    expect(await runPrCli(['checks', '78', '--wait'], { forge, runner, clock }, io)).toBe(1);
    expect(clock.slept).toHaveLength(3);
  });

  it('--wait で猶予を過ぎてもチェックが無ければ none で 0 で終わる', async () => {
    const clock = fakeClock();
    const { runner } = fakeRunner(responder([[]]));

    expect(await runPrCli(['checks', '78', '--wait'], { forge, runner, clock }, io)).toBe(0);
    expect(clock.now()).toBeGreaterThanOrEqual(120_000);
    expect(stdout).toContain(': none');
  });

  it('--wait で上限まで走り続けたら、待ち切れなかったとして 2 で終わる', async () => {
    const clock = fakeClock();
    const { runner } = fakeRunner(responder([[running]]));

    expect(
      await runPrCli(['checks', '78', '--wait', '--timeout', '40'], { forge, runner, clock }, io)
    ).toBe(2);
    expect(clock.slept).toEqual([15_000, 15_000]);
    expect(stdout).toContain('（待ち切れませんでした）');
  });

  it('--timeout の誤りと、--wait なしの --timeout を拒む', async () => {
    const { runner, calls } = fakeRunner(responder([[success]]));

    expect(await runPrCli(['checks', '78', '--timeout', '30'], { forge, runner }, io)).toBe(1);
    expect(stderr).toContain('--timeout は --wait と一緒に');
    expect(
      await runPrCli(['checks', '78', '--wait', '--timeout', '0'], { forge, runner }, io)
    ).toBe(1);
    expect(
      await runPrCli(['checks', '78', '--wait', '--timeout', 'x'], { forge, runner }, io)
    ).toBe(1);
    expect(calls).toHaveLength(0);
  });

  it('PR やチェックを読めなければ、落ちた（1）と見分けられる 3 で終わる', async () => {
    const { runner } = fakeRunner(() => failed(404));

    expect(await runPrCli(['checks', '999'], { forge, runner }, io)).toBe(3);
    expect(stderr).toContain('PR #999 のチェックを読めませんでした');

    const broken = fakeRunner((args) =>
      (args[args.length - 1] ?? '').endsWith('/pulls/78') ? json(pr) : failed(502)
    );
    expect(await runPrCli(['checks', '78'], { forge, runner: broken.runner }, io)).toBe(3);
  });

  it('status は check-runs と同じく全件を 1 件 1 行で引く', async () => {
    const { runner, calls } = fakeRunner(responder([[success]]));

    expect(await runPrCli(['checks', '78'], { forge, runner }, io)).toBe(0);
    const statusCall = calls.find((c) => c.args.some((a) => a.includes('/status')));
    expect(statusCall?.args).toEqual([
      'api',
      '--paginate',
      '--jq',
      '.statuses[]',
      `repos/iepyon/ai-board/commits/${SHA}/status?per_page=100`,
    ]);
  });

  it('--sha は PR の head がそのコミットになるまで走っているとして待ち、そのコミットのチェックを見る', async () => {
    const NEW = '9999999aaaaaaa';
    let prCalls = 0;
    const { runner, calls } = fakeRunner((args) => {
      const endpoint = args[args.length - 1] ?? '';
      if (endpoint.endsWith('/pulls/78')) {
        prCalls += 1;
        // 最初の 2 回は push が PR に映っておらず、head は前のコミットのまま
        return json({ ...pr, head: { ref: 'b', sha: prCalls <= 2 ? SHA : NEW } });
      }
      if (endpoint.includes(`/commits/${SHA}/`)) return lines([success]);
      if (endpoint.includes(`/commits/${NEW}/check-runs`)) return lines([failure]);
      if (endpoint.includes(`/commits/${NEW}/status`)) return lines([]);
      return failed(404);
    });
    const clock = fakeClock();

    expect(
      await runPrCli(['checks', '78', '--wait', '--sha', NEW], { forge, runner, clock }, io)
    ).toBe(1);
    expect(clock.slept).toEqual([15_000, 15_000]);
    expect(calls.some((c) => c.args.some((a) => a.includes(`/commits/${SHA}/`)))).toBe(false);
    expect(stdout).toContain('落ちた  test (22)');
  });

  it('--sha のコミットにチェックがまだ無い間の猶予は、head がそのコミットになった時から数える', async () => {
    const NEW = '9999999aaaaaaa';
    let prCalls = 0;
    const { runner } = fakeRunner((args) => {
      const endpoint = args[args.length - 1] ?? '';
      if (endpoint.endsWith('/pulls/78')) {
        prCalls += 1;
        // 9 回（120 秒ぶん）は head が前のコミットのまま
        return json({ ...pr, head: { ref: 'b', sha: prCalls <= 9 ? SHA : NEW } });
      }
      // head が動いた後、2 回目まではチェックがまだ登録されていない
      if (endpoint.includes('/check-runs')) return lines(prCalls <= 11 ? [] : [success]);
      return lines([]);
    });
    const clock = fakeClock();

    expect(
      await runPrCli(['checks', '78', '--wait', '--sha', NEW], { forge, runner, clock }, io)
    ).toBe(0);
    expect(stdout).toContain(': passed');
    expect(clock.slept).toHaveLength(11);
  });

  it('--sha に head の短いハッシュを渡しても、待たずにそのコミットのチェックを読む', async () => {
    const { runner } = fakeRunner(responder([[success]]));

    expect(await runPrCli(['checks', '78', '--sha', SHA.slice(0, 7)], { forge, runner }, io)).toBe(
      0
    );
    expect(stdout).toContain(`最新コミット ${SHA.slice(0, 7)} のチェック: passed`);
    expect(stdout).not.toContain('head はまだ');
  });

  it('--wait --sha に head の短いハッシュを渡しても、待たずにそのコミットのチェックで終える', async () => {
    const { runner } = fakeRunner(responder([[success]]));
    const clock = fakeClock();

    expect(
      await runPrCli(
        ['checks', '78', '--wait', '--sha', SHA.slice(0, 7), '--json'],
        { forge, runner, clock },
        io
      )
    ).toBe(0);
    expect(clock.slept).toEqual([]);
    expect(JSON.parse(stdout)).toMatchObject({ sha: SHA, verdict: 'passed', timedOut: false });
  });

  it('--sha の短いハッシュが head と別のコミットなら、走っているとして扱う', async () => {
    const { runner, calls } = fakeRunner(responder([[success]]));

    expect(await runPrCli(['checks', '78', '--sha', '9999999'], { forge, runner }, io)).toBe(2);
    expect(stdout).toContain('最新コミット 9999999 のチェック: pending');
    expect(stdout).toContain(
      `PR の head はまだ ${SHA.slice(0, 7)} で、このコミットになっていません`
    );
    expect(calls.some((c) => c.args.some((a) => a.includes('/check-runs')))).toBe(false);
  });
});

describe('ai-board pr checks で status を権限で読めないとき', () => {
  const SHA = 'abcdef1234567890';

  it('check-runs だけで判定し、status を読めなかったことを出す。ほかの失敗は止める', async () => {
    const respond =
      (statusResult: Result<string, CliError>): Responder =>
      (args) => {
        const endpoint = args[args.length - 1] ?? '';
        if (endpoint.endsWith('/pulls/78'))
          return json({ number: 78, head: { ref: 'b', sha: SHA } });
        if (endpoint.includes('/check-runs')) {
          return ok(
            `${JSON.stringify({ name: 't', status: 'completed', conclusion: 'success' })}\n`
          );
        }
        return statusResult;
      };

    expect(
      await runPrCli(
        ['checks', '78'],
        { forge, runner: fakeRunner(respond(failed(403))).runner },
        io
      )
    ).toBe(0);
    expect(stdout).toContain('status（Commit Status API）は読めませんでした（HTTP 403）');

    stdout = '';
    expect(
      await runPrCli(
        ['checks', '78', '--json'],
        { forge, runner: fakeRunner(respond(failed(403))).runner },
        io
      )
    ).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ verdict: 'passed', statusUnreadable: 'HTTP 403' });

    expect(
      await runPrCli(
        ['checks', '78'],
        { forge, runner: fakeRunner(respond(failed(500))).runner },
        io
      )
    ).toBe(3);
    expect(stderr).toContain('チェックを読めませんでした');
  });
});
