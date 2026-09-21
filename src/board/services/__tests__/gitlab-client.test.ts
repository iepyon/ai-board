import { describe, it, expect, vi } from 'vitest';
import { GlabForgeClient } from '../gitlab-client.js';
import type { ForgeConfig } from '../../../shared/config.js';
import type { MergeRequestIid } from '../../../shared/schemas/common.js';
import type { CliRunner, RunOptions } from '../../../infrastructure/cli-runner.js';
import { ok, err } from '../../../shared/result.js';

const config: Extract<ForgeConfig, { kind: 'gitlab' }> = {
  kind: 'gitlab',
  url: 'http://localhost:8929',
  projectId: 3,
};

interface RouteMap {
  [pathSuffix: string]: unknown;
}

interface Call {
  readonly args: readonly string[];
  readonly options: RunOptions | undefined;
}

/**
 * glab の実行モック。
 *
 * notes / commits は MR 本体とパスの前方部分を共有するため、
 * 先に振り分けてから MR 本体のルートを探す。
 */
function stubRunner(routes: RouteMap, notFound: readonly string[] = []) {
  const calls: Call[] = [];

  const runner: CliRunner = {
    run: vi.fn(async (_command: string, args: readonly string[], options?: RunOptions) => {
      calls.push({ args, options });

      const path = args[args.length - 1] ?? '';

      if (args[0] === 'auth') return ok('logged in');

      if (notFound.some((suffix) => path.includes(suffix))) {
        return err({
          type: 'Failed' as const,
          command: 'glab',
          message: '終了コード 1 で失敗した',
          httpStatus: 404,
        });
      }

      return ok(JSON.stringify(resolveBody(path, routes)));
    }),
  };

  return { runner, calls };
}

function resolveBody(path: string, routes: RouteMap): unknown {
  if (path.includes('/notes')) {
    return findRoute(path, routes, (key) => key.includes('/notes')) ?? [];
  }
  if (path.includes('/commits')) {
    return findRoute(path, routes, (key) => key.includes('/commits')) ?? [];
  }

  return (
    findRoute(path, routes, (key) => !key.includes('/notes') && !key.includes('/commits')) ?? []
  );
}

function findRoute(path: string, routes: RouteMap, keyFilter: (key: string) => boolean): unknown {
  const key = Object.keys(routes)
    .filter(keyFilter)
    .sort((a, b) => b.length - a.length)
    .find((suffix) => path.includes(suffix));

  return key === undefined ? undefined : routes[key];
}

const openMr = {
  iid: 42,
  state: 'opened',
  source_branch: 'feat/refresh-token',
  title: 'リフレッシュトークン対応',
  web_url: 'http://localhost:8929/g/p/-/merge_requests/42',
};

describe('GlabForgeClient', () => {
  it('iid から MR を取得しノートとコミットで補強する', async () => {
    const { runner } = stubRunner({
      '/merge_requests/42/notes': [
        { system: false, created_at: '2026-09-04T10:00:00.000Z' },
        { system: true, created_at: '2026-09-04T12:00:00.000Z' },
      ],
      '/merge_requests/42/commits': [{ committed_date: '2026-09-04T10:30:00.000Z' }],
      '/merge_requests/42': openMr,
    });

    const mr = await new GlabForgeClient(config, runner).fetchByIid(42 as MergeRequestIid);

    expect(mr?.iid).toBe(42);
    expect(mr?.state).toBe('opened');
    // system note は除外されるので最新は 10:00 のまま
    expect(mr?.latestNoteAt).toBe('2026-09-04T10:00:00.000Z');
    expect(mr?.noteCount).toBe(1);
    expect(mr?.latestCommitAt).toBe('2026-09-04T10:30:00.000Z');
  });

  it('GITLAB_HOST で設定のホストを明示的に固定する', async () => {
    const { runner, calls } = stubRunner({ '/merge_requests/42': openMr });

    await new GlabForgeClient(config, runner).fetchByIid(42 as MergeRequestIid);

    // 既定ホストに任せると、複数インスタンスにログインしているとき別の MR を引く
    expect(calls[0]?.options?.env).toEqual({ GITLAB_HOST: 'localhost:8929' });
  });

  it('トークンを引数にも環境変数にも渡さない', async () => {
    const { runner, calls } = stubRunner({ '/merge_requests/42': openMr });

    await new GlabForgeClient(config, runner).fetchByIid(42 as MergeRequestIid);

    expect(JSON.stringify(calls)).not.toMatch(/token/i);
  });

  it('404 は null を返す', async () => {
    const { runner } = stubRunner({}, ['/merge_requests/99']);

    expect(await new GlabForgeClient(config, runner).fetchByIid(99 as MergeRequestIid)).toBeNull();
  });

  it('404 以外のエラーは例外にする', async () => {
    const runner: CliRunner = {
      run: vi.fn(async () =>
        err({
          type: 'Failed' as const,
          command: 'glab',
          message: '終了コード 1 で失敗した',
          httpStatus: 403,
        })
      ),
    };

    await expect(
      new GlabForgeClient(config, runner).fetchByIid(42 as MergeRequestIid)
    ).rejects.toThrow(/glab/);
  });

  it('ブランチから MR を解決する', async () => {
    const { runner } = stubRunner({
      '/merge_requests?source_branch': [openMr],
      '/merge_requests/42/notes': [],
      '/merge_requests/42/commits': [{ committed_date: '2026-09-04T10:30:00.000Z' }],
    });

    const mr = await new GlabForgeClient(config, runner).fetchByBranch('feat/refresh-token');

    expect(mr?.iid).toBe(42);
    expect(mr?.latestNoteAt).toBeNull();
    expect(mr?.noteCount).toBe(0);
  });

  it('ブランチに対応する MR が無ければ null', async () => {
    const { runner } = stubRunner({ '/merge_requests?source_branch': [] });

    expect(await new GlabForgeClient(config, runner).fetchByBranch('feat/nothing')).toBeNull();
  });

  it('未知の state は closed に丸める', async () => {
    const { runner } = stubRunner({ '/merge_requests/42': { ...openMr, state: 'unknown-state' } });

    const mr = await new GlabForgeClient(config, runner).fetchByIid(42 as MergeRequestIid);

    expect(mr?.state).toBe('closed');
  });

  it('プロジェクト ID がパス形式でも URL エンコードして使う', async () => {
    const { runner, calls } = stubRunner({ '/merge_requests/42': openMr });

    await new GlabForgeClient({ ...config, projectId: 'group/project' }, runner).fetchByIid(
      42 as MergeRequestIid
    );

    expect(calls[0]?.args.at(-1)).toContain('projects/group%2Fproject/');
  });
});

describe('GlabForgeClient.checkAuth', () => {
  it('ログイン済みなら null を返す', async () => {
    const { runner } = stubRunner({});

    expect(await new GlabForgeClient(config, runner).checkAuth()).toBeNull();
  });

  it('glab が無ければ理由を返す', async () => {
    const runner: CliRunner = {
      run: vi.fn(async () => err({ type: 'NotInstalled' as const, command: 'glab' })),
    };

    expect(await new GlabForgeClient(config, runner).checkAuth()).toContain('見つからない');
  });

  it('未ログインなら理由を返す', async () => {
    const runner: CliRunner = {
      run: vi.fn(async () =>
        err({
          type: 'Failed' as const,
          command: 'glab',
          message: '終了コード 1 で失敗した',
          httpStatus: null,
        })
      ),
    };

    expect(await new GlabForgeClient(config, runner).checkAuth()).toContain('glab');
  });
});
