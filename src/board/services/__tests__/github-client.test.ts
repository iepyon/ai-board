import { describe, it, expect, vi } from 'vitest';
import { GhForgeClient, toLifecycleState } from '../github-client.js';
import type { ForgeConfig } from '../../../shared/config.js';
import type { MergeRequestIid } from '../../../shared/schemas/common.js';
import type { CliRunner } from '../../../infrastructure/cli-runner.js';
import { ok, err } from '../../../shared/result.js';

const config: Extract<ForgeConfig, { kind: 'github' }> = {
  kind: 'github',
  owner: 'iepyon',
  repo: 'ai-board',
};

interface RouteMap {
  [pathSuffix: string]: unknown;
}

function stubRunner(routes: RouteMap, notFound: readonly string[] = []) {
  const paths: string[] = [];

  const runner: CliRunner = {
    run: vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[0] === 'auth') return ok('logged in');

      const path = args[args.length - 1] ?? '';
      paths.push(path);

      if (notFound.some((suffix) => path.includes(suffix))) {
        return err({
          type: 'Failed' as const,
          command: 'gh',
          message: '終了コード 1 で失敗した',
          httpStatus: 404,
        });
      }

      const key = Object.keys(routes)
        .sort((a, b) => b.length - a.length)
        .find((suffix) => path.includes(suffix));

      return ok(JSON.stringify(key === undefined ? [] : routes[key]));
    }),
  };

  return { runner, paths };
}

const openPr = {
  number: 7,
  state: 'open',
  merged_at: null,
  head: { ref: 'feat/refresh-token', sha: 'deadbeef' },
  title: 'リフレッシュトークン対応',
  html_url: 'https://github.com/iepyon/ai-board/pull/7',
};

describe('toLifecycleState', () => {
  it('open は opened になる', () => {
    expect(toLifecycleState('open', null)).toBe('opened');
  });

  it('closed かつ merged_at があれば merged になる', () => {
    // GitHub の state は open / closed の 2 値しかなく、マージ済みも closed で返る。
    // ここを取り違えるとマージした PR がカードの merged 列へ上がらない
    expect(toLifecycleState('closed', '2026-09-20T00:00:00Z')).toBe('merged');
  });

  it('closed かつ merged_at が無ければ closed のまま', () => {
    expect(toLifecycleState('closed', null)).toBe('closed');
  });
});

describe('GhForgeClient', () => {
  it('番号から PR を取得しコメントとコミットで補強する', async () => {
    const { runner } = stubRunner({
      'issues/7/comments': [{ created_at: '2026-09-04T10:00:00.000Z' }],
      'pulls/7/comments': [{ created_at: '2026-09-04T11:00:00.000Z' }],
      'commits/deadbeef': { commit: { committer: { date: '2026-09-04T12:00:00.000Z' } } },
      'pulls/7': openPr,
    });

    const pr = await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid);

    expect(pr?.iid).toBe(7);
    expect(pr?.state).toBe('opened');
    expect(pr?.sourceBranch).toBe('feat/refresh-token');
    // 2 種類のコメントを合算する
    expect(pr?.noteCount).toBe(2);
    expect(pr?.latestNoteAt).toBe('2026-09-04T11:00:00.000Z');
    expect(pr?.latestCommitAt).toBe('2026-09-04T12:00:00.000Z');
  });

  it('コード行への指摘だけでも件数に数える', async () => {
    const { runner } = stubRunner({
      'issues/7/comments': [],
      'pulls/7/comments': [{ created_at: '2026-09-04T11:00:00.000Z' }],
      'pulls/7': openPr,
    });

    const pr = await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid);

    expect(pr?.noteCount).toBe(1);
    expect(pr?.latestNoteAt).toBe('2026-09-04T11:00:00.000Z');
  });

  it('コメントが 1 件も無ければ 0 件と null', async () => {
    const { runner } = stubRunner({ 'pulls/7': openPr });

    const pr = await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid);

    expect(pr?.noteCount).toBe(0);
    expect(pr?.latestNoteAt).toBeNull();
  });

  it('コミットが取れなければ latestCommitAt は null', async () => {
    const { runner } = stubRunner({ 'pulls/7': openPr });

    const pr = await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid);

    expect(pr?.latestCommitAt).toBeNull();
  });

  it('最新コミットは head.sha を直接引く', async () => {
    // pulls/{n}/commits は古い順の 1 ページ目しか返さず、
    // コミットが 100 件を超えた PR で tip を取り逃がす
    const { runner, paths } = stubRunner({
      'pulls/7': openPr,
      'commits/deadbeef': { commit: { committer: { date: '2026-09-04T12:00:00.000Z' } } },
    });

    const pr = await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid);

    expect(pr?.latestCommitAt).toBe('2026-09-04T12:00:00.000Z');
    expect(paths.some((path) => path.includes('/commits/deadbeef'))).toBe(true);
    expect(paths.some((path) => path.includes('pulls/7/commits'))).toBe(false);
  });

  it('bot のコメントは人のレビューに数えない', async () => {
    const { runner } = stubRunner({
      'issues/7/comments': [
        { created_at: '2026-09-04T13:00:00.000Z', user: { type: 'Bot' } },
        { created_at: '2026-09-04T10:00:00.000Z', user: { type: 'User' } },
      ],
      'pulls/7': openPr,
    });

    const pr = await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid);

    expect(pr?.noteCount).toBe(1);
    expect(pr?.latestNoteAt).toBe('2026-09-04T10:00:00.000Z');
  });

  it('コメントは新しい順に取る', async () => {
    // 既定は古い順で 1 ページ目しか読まないため、
    // 100 件を超えた PR で最終時刻が最新でなくなる
    const { runner, paths } = stubRunner({ 'pulls/7': openPr });

    await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid);

    const commentPaths = paths.filter((path) => path.includes('comments'));
    expect(commentPaths).toHaveLength(2);
    for (const path of commentPaths) expect(path).toContain('direction=desc');
  });

  it('マージ済みの PR を merged として返す', async () => {
    const { runner } = stubRunner({
      'pulls/7': { ...openPr, state: 'closed', merged_at: '2026-09-20T00:00:00Z' },
    });

    const pr = await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid);

    expect(pr?.state).toBe('merged');
  });

  it('ブランチから PR を解決するとき head に owner 接頭辞を付ける', async () => {
    const { runner, paths } = stubRunner({ 'pulls?head': [openPr] });

    await new GhForgeClient(config, runner).fetchByBranch('feat/refresh-token');

    // 接頭辞を落とすと他リポジトリの同名ブランチを拾う
    expect(paths[0]).toContain(encodeURIComponent('iepyon:feat/refresh-token'));
  });

  it('ブランチに対応する PR が無ければ null', async () => {
    const { runner } = stubRunner({ 'pulls?head': [] });

    expect(await new GhForgeClient(config, runner).fetchByBranch('feat/nothing')).toBeNull();
  });

  it('存在しない番号は例外ではなく null を返す', async () => {
    const { runner } = stubRunner({}, ['pulls/99']);

    expect(await new GhForgeClient(config, runner).fetchByIid(99 as MergeRequestIid)).toBeNull();
  });

  it('404 以外のエラーは例外にする', async () => {
    const runner: CliRunner = {
      run: vi.fn(async () =>
        err({
          type: 'Failed' as const,
          command: 'gh',
          message: '終了コード 1 で失敗した',
          httpStatus: 500,
        })
      ),
    };

    await expect(
      new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid)
    ).rejects.toThrow(/gh/);
  });

  it('トークンを引数に渡さない', async () => {
    const { runner, paths } = stubRunner({ 'pulls/7': openPr });

    await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid);

    expect(JSON.stringify(paths)).not.toMatch(/token/i);
  });
});

describe('GhForgeClient.checkAuth', () => {
  it('ログイン済みなら null を返す', async () => {
    const { runner } = stubRunner({});

    expect(await new GhForgeClient(config, runner).checkAuth()).toBeNull();
  });

  it('gh が無ければ理由を返す', async () => {
    const runner: CliRunner = {
      run: vi.fn(async () => err({ type: 'NotInstalled' as const, command: 'gh' })),
    };

    expect(await new GhForgeClient(config, runner).checkAuth()).toContain('見つからない');
  });
});
