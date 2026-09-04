import { describe, it, expect, vi } from 'vitest';
import { HttpGitLabClient } from '../gitlab-client.js';
import type { GitLabConfig } from '../../../shared/config.js';
import type { MergeRequestIid } from '../../../shared/schemas/common.js';

const config: GitLabConfig = {
  url: 'http://localhost:8080',
  projectId: 3,
  token: 'test-token',
};

interface RouteMap {
  [pathSuffix: string]: unknown;
}

/**
 * fetch モック。
 *
 * notes / commits は MR 本体と URL の前方部分を共有するため、
 * 先に振り分けてから MR 本体のルートを探す。
 */
function mockFetch(routes: RouteMap, notFound: readonly string[] = []) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);

    if (notFound.some((suffix) => url.includes(suffix))) {
      return new Response('null', { status: 404 });
    }

    const body = resolveBody(url, routes);

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

function resolveBody(url: string, routes: RouteMap): unknown {
  // notes / commits の URL は MR 本体の URL を前方に含むため、
  // それぞれ専用のキーだけを照合対象にする
  if (url.includes('/notes')) {
    return findRoute(url, routes, (key) => key.includes('/notes')) ?? [];
  }
  if (url.includes('/commits')) {
    return findRoute(url, routes, (key) => key.includes('/commits')) ?? [];
  }

  return (
    findRoute(url, routes, (key) => !key.includes('/notes') && !key.includes('/commits')) ?? []
  );
}

function findRoute(url: string, routes: RouteMap, keyFilter: (key: string) => boolean): unknown {
  const key = Object.keys(routes)
    .filter(keyFilter)
    .sort((a, b) => b.length - a.length)
    .find((suffix) => url.includes(suffix));

  return key === undefined ? undefined : routes[key];
}

const openMr = {
  iid: 42,
  state: 'opened',
  source_branch: 'feat/refresh-token',
  title: 'リフレッシュトークン対応',
  web_url: 'http://localhost:8080/g/p/-/merge_requests/42',
};

describe('HttpGitLabClient', () => {
  it('iid から MR を取得しノートとコミットで補強する', async () => {
    const fetchFn = mockFetch({
      '/merge_requests/42/notes': [
        { system: false, created_at: '2026-09-04T10:00:00.000Z' },
        { system: true, created_at: '2026-09-04T12:00:00.000Z' },
      ],
      '/merge_requests/42/commits': [{ committed_date: '2026-09-04T10:30:00.000Z' }],
      '/merge_requests/42': openMr,
    });

    const mr = await new HttpGitLabClient(config, fetchFn).fetchByIid(42 as MergeRequestIid);

    expect(mr?.iid).toBe(42);
    expect(mr?.state).toBe('opened');
    // system note は除外されるので最新は 10:00 のまま
    expect(mr?.latestNoteAt).toBe('2026-09-04T10:00:00.000Z');
    expect(mr?.noteCount).toBe(1);
    expect(mr?.latestCommitAt).toBe('2026-09-04T10:30:00.000Z');
  });

  it('PRIVATE-TOKEN ヘッダを付ける', async () => {
    const fetchFn = mockFetch({ '/merge_requests/42': openMr });

    await new HttpGitLabClient(config, fetchFn).fetchByIid(42 as MergeRequestIid);

    const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)['PRIVATE-TOKEN']).toBe('test-token');
  });

  it('404 は null を返す', async () => {
    const fetchFn = mockFetch({}, ['/merge_requests/99']);

    expect(
      await new HttpGitLabClient(config, fetchFn).fetchByIid(99 as MergeRequestIid)
    ).toBeNull();
  });

  it('404 以外のエラーは例外にする', async () => {
    const fetchFn = vi.fn(
      async () => new Response('forbidden', { status: 403 })
    ) as unknown as typeof fetch;

    await expect(
      new HttpGitLabClient(config, fetchFn).fetchByIid(42 as MergeRequestIid)
    ).rejects.toThrow(/403/);
  });

  it('ブランチから MR を解決する', async () => {
    const fetchFn = mockFetch({
      '/merge_requests?source_branch': [openMr],
      '/merge_requests/42/notes': [],
      '/merge_requests/42/commits': [{ committed_date: '2026-09-04T10:30:00.000Z' }],
    });

    const mr = await new HttpGitLabClient(config, fetchFn).fetchByBranch('feat/refresh-token');

    expect(mr?.iid).toBe(42);
    expect(mr?.latestNoteAt).toBeNull();
    expect(mr?.noteCount).toBe(0);
  });

  it('ブランチに対応する MR が無ければ null', async () => {
    const fetchFn = mockFetch({ '/merge_requests?source_branch': [] });

    expect(await new HttpGitLabClient(config, fetchFn).fetchByBranch('feat/nothing')).toBeNull();
  });

  it('未知の state は closed に丸める', async () => {
    const fetchFn = mockFetch({ '/merge_requests/42': { ...openMr, state: 'unknown-state' } });

    const mr = await new HttpGitLabClient(config, fetchFn).fetchByIid(42 as MergeRequestIid);

    expect(mr?.state).toBe('closed');
  });

  it('プロジェクト ID がパス形式でも URL エンコードして使う', async () => {
    const fetchFn = mockFetch({ '/merge_requests/42': openMr });

    await new HttpGitLabClient({ ...config, projectId: 'group/project' }, fetchFn).fetchByIid(
      42 as MergeRequestIid
    );

    const [url] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toContain('/projects/group%2Fproject/');
  });
});
