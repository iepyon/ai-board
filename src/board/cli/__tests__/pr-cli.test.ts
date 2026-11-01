import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs, existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CliError, CliRunner } from '../../../infrastructure/cli-runner.js';
import type { ForgeConfig } from '../../../shared/config.js';
import { err, ok, type Result } from '../../../shared/result.js';
import { isPrCommand, runPrCli } from '../pr-cli.js';

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
    expect(calls[0]?.input).toEqual({ body: '判断してほしい点\n' });
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
