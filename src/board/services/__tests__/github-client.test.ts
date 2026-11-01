import { describe, it, expect, vi } from 'vitest';
import { GhForgeClient, toLifecycleState } from '../github-client.js';
import type { ForgeConfig } from '../../../shared/config.js';
import type { MergeRequestIid } from '../../../shared/schemas/common.js';
import type { CliRunner } from '../../../infrastructure/cli-runner.js';
import { ok, err } from '../../../shared/result.js';

const config: ForgeConfig = {
  kind: 'github',
  owner: 'iepyon',
  repo: 'ai-board',
};

interface RouteMap {
  [pathSuffix: string]: unknown;
}

function stubRunner(routes: RouteMap, notFound: readonly string[] = []) {
  const paths: string[] = [];
  const argv: string[][] = [];

  const runner: CliRunner = {
    run: vi.fn(async (_command: string, args: readonly string[]) => {
      const path = args[args.length - 1] ?? '';
      paths.push(path);
      argv.push([...args]);

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

  return { runner, paths, argv };
}

const openPr = {
  number: 7,
  state: 'open',
  merged_at: null,
  head: { ref: 'feat/refresh-token', sha: 'deadbeef' },
  title: 'リフレッシュトークン対応',
  html_url: 'https://github.com/iepyon/ai-board/pull/7',
  created_at: '2026-09-04T08:00:00Z',
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

    const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

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

    const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

    expect(pr?.noteCount).toBe(1);
    expect(pr?.latestNoteAt).toBe('2026-09-04T11:00:00.000Z');
  });

  it('コメントが 1 件も無ければ 0 件と null', async () => {
    const { runner } = stubRunner({ 'pulls/7': openPr });

    const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

    expect(pr?.noteCount).toBe(0);
    expect(pr?.latestNoteAt).toBeNull();
  });

  it('コミットが取れなければ latestCommitAt は null', async () => {
    const { runner } = stubRunner({ 'pulls/7': openPr });

    const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

    expect(pr?.latestCommitAt).toBeNull();
  });

  it('最新コミットは head.sha を直接引く', async () => {
    // pulls/{n}/commits は古い順の 1 ページ目しか返さず、
    // コミットが 100 件を超えた PR で tip を取り逃がす
    const { runner, paths } = stubRunner({
      'pulls/7': openPr,
      'commits/deadbeef': { commit: { committer: { date: '2026-09-04T12:00:00.000Z' } } },
    });

    const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

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

    const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

    expect(pr?.noteCount).toBe(1);
    expect(pr?.latestNoteAt).toBe('2026-09-04T10:00:00.000Z');
  });

  it('コメントは全ページ取る', async () => {
    // issues/{n}/comments は sort / direction を受け付けない（受けるのは
    // リポジトリ単位の方）。既定は古い順の 1 ページ目なので、並び順に頼ると
    // 100 件を超えた PR で最終時刻が最新でなくなる
    const { runner, argv } = stubRunner({ 'pulls/7': openPr });

    await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid);

    const commentCalls = argv.filter((args) => args.join(' ').includes('comments'));
    expect(commentCalls).toHaveLength(2);
    for (const args of commentCalls) expect(args).toContain('--paginate');
  });

  it('最終コメント時刻はページ内の並び順に依らず最大を取る', async () => {
    const { runner } = stubRunner({
      'pulls/7': openPr,
      'issues/7/comments': [
        { created_at: '2026-09-04T09:00:00.000Z' },
        { created_at: '2026-09-04T12:00:00.000Z' },
        { created_at: '2026-09-04T10:00:00.000Z' },
      ],
    });

    const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

    expect(pr?.latestNoteAt).toBe('2026-09-04T12:00:00.000Z');
  });

  it('取得先を github として返す', async () => {
    const { runner } = stubRunner({ 'pulls/7': openPr });

    const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

    expect(pr?.forge).toBe('github');
  });

  it('マージ済みの PR を merged として返す', async () => {
    const { runner } = stubRunner({
      'pulls/7': { ...openPr, state: 'closed', merged_at: '2026-09-20T00:00:00Z' },
    });

    const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

    expect(pr?.state).toBe('merged');
    expect(pr?.mergedAt).toBe('2026-09-20T00:00:00Z');
  });

  it('Draft の PR を draft として返す', async () => {
    const { runner } = stubRunner({ 'pulls/7': { ...openPr, draft: true } });

    const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

    expect(pr?.draft).toBe(true);
  });

  describe('Draft に戻された時刻', () => {
    const draftPr = { ...openPr, draft: true };

    it('open かつ Draft の PR はイベントを全ページ引き、convert_to_draft の最新を取る', async () => {
      const { runner, argv } = stubRunner({
        'pulls/7': draftPr,
        'issues/7/events': [
          { event: 'convert_to_draft', created_at: '2026-09-04T09:00:00Z' },
          { event: 'ready_for_review', created_at: '2026-09-04T13:00:00Z' },
          { event: 'convert_to_draft', created_at: '2026-09-04T12:00:00Z' },
          { event: 'convert_to_draft', created_at: '2026-09-04T10:00:00Z' },
        ],
      });

      const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

      // ready_for_review の方が新しくても、拾うのは convert_to_draft だけ
      expect(pr?.convertedToDraftAt).toBe('2026-09-04T12:00:00Z');
      const eventCalls = argv.filter((args) => args.join(' ').includes('issues/7/events'));
      expect(eventCalls).toHaveLength(1);
      expect(eventCalls[0]).toContain('--paginate');
    });

    it('convert_to_draft のイベントが無ければ null', async () => {
      // 作成時から Draft の PR はこのイベントを残さない
      const { runner } = stubRunner({
        'pulls/7': draftPr,
        'issues/7/events': [{ event: 'labeled', created_at: '2026-09-04T09:00:00Z' }],
      });

      const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

      expect(pr?.convertedToDraftAt).toBeNull();
    });

    it.each([
      ['Ready の PR', openPr],
      ['マージ済みの PR', { ...openPr, state: 'closed', merged_at: '2026-09-20T00:00:00Z' }],
      ['閉じた Draft の PR', { ...draftPr, state: 'closed' }],
    ])('%s では convert_to_draft があっても null', async (_label, raw) => {
      // 止まりの判定は「今 open かつ Draft のときだけ値を持つ」前提で読む
      const { runner } = stubRunner({
        'pulls/7': raw,
        'issues/7/events': [{ event: 'convert_to_draft', created_at: '2026-09-04T09:00:00Z' }],
      });

      const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

      expect(pr?.convertedToDraftAt).toBeNull();
    });
  });

  describe('Ready にした時刻', () => {
    const mergedPr = { ...openPr, state: 'closed', merged_at: '2026-09-20T00:00:00Z' };

    it.each([
      ['Ready の PR', openPr],
      ['マージ済みの PR', mergedPr],
      ['Draft の PR', { ...openPr, draft: true }],
    ])('%s でもイベントを全ページ 1 回だけ引く', async (_label, raw) => {
      const { runner, argv } = stubRunner({ 'pulls/7': raw });

      await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid);

      const eventCalls = argv.filter((args) => args.join(' ').includes('issues/7/events'));
      expect(eventCalls).toHaveLength(1);
      expect(eventCalls[0]).toContain('--paginate');
    });

    it('Ready と Draft を行き来した PR は、最後の ready_for_review を取る', async () => {
      const { runner } = stubRunner({
        'pulls/7': openPr,
        'issues/7/events': [
          { event: 'ready_for_review', created_at: '2026-09-04T09:00:00Z' },
          { event: 'ready_for_review', created_at: '2026-09-04T13:00:00Z' },
          { event: 'convert_to_draft', created_at: '2026-09-04T14:00:00Z' },
          { event: 'ready_for_review', created_at: '2026-09-04T11:00:00Z' },
        ],
      });

      const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

      // 並び順に依らず最大を取る。convert_to_draft の方が新しくても拾わない
      expect(pr?.readyAt).toBe('2026-09-04T13:00:00Z');
    });

    it('作成時から Ready の PR は、PR の作成時刻を取る', async () => {
      // 作成時から Ready の PR は ready_for_review を残さない
      const { runner } = stubRunner({
        'pulls/7': openPr,
        'issues/7/events': [{ event: 'labeled', created_at: '2026-09-04T09:00:00Z' }],
      });

      const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

      expect(pr?.readyAt).toBe('2026-09-04T08:00:00Z');
    });

    it('マージ済みの PR は、最後の ready_for_review を取る', async () => {
      const { runner } = stubRunner({
        'pulls/7': mergedPr,
        'issues/7/events': [{ event: 'ready_for_review', created_at: '2026-09-10T00:00:00Z' }],
      });

      const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

      expect(pr?.readyAt).toBe('2026-09-10T00:00:00Z');
    });

    it('ready_for_review の無いマージ済みの PR は、PR の作成時刻を取る', async () => {
      const { runner } = stubRunner({ 'pulls/7': mergedPr });

      const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

      expect(pr?.readyAt).toBe('2026-09-04T08:00:00Z');
    });

    it('一度も Ready にしていない Draft の PR は null', async () => {
      const { runner } = stubRunner({
        'pulls/7': { ...openPr, draft: true },
        'issues/7/events': [{ event: 'labeled', created_at: '2026-09-04T09:00:00Z' }],
      });

      const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

      expect(pr?.readyAt).toBeNull();
    });

    it('Ready にしてから Draft に戻した PR は、最後の ready_for_review を残す', async () => {
      const { runner } = stubRunner({
        'pulls/7': { ...openPr, draft: true },
        'issues/7/events': [
          { event: 'ready_for_review', created_at: '2026-09-04T09:00:00Z' },
          { event: 'convert_to_draft', created_at: '2026-09-04T12:00:00Z' },
        ],
      });

      const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

      expect(pr?.readyAt).toBe('2026-09-04T09:00:00Z');
      expect(pr?.convertedToDraftAt).toBe('2026-09-04T12:00:00Z');
    });

    it('作成時刻が欠けた応答で Ready のイベントも無ければ null', async () => {
      const { created_at: _createdAt, ...withoutCreatedAt } = openPr;
      const { runner } = stubRunner({ 'pulls/7': withoutCreatedAt });

      const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

      expect(pr?.readyAt).toBeNull();
    });
  });

  it('draft が欠けた応答は Draft でないとみなす', async () => {
    const { runner } = stubRunner({ 'pulls/7': openPr });

    const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

    expect(pr?.draft).toBe(false);
  });

  it('マージされていない PR の mergedAt は null', async () => {
    const { runner } = stubRunner({ 'pulls/7': openPr });

    const pr = (await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid))?.mr;

    expect(pr?.mergedAt).toBeNull();
  });

  describe('前回の結果との比較', () => {
    const counted = {
      ...openPr,
      draft: false,
      comments: 1,
      review_comments: 0,
      updated_at: '2026-09-04T12:00:00Z',
    };

    async function firstFetch() {
      const { runner } = stubRunner({ 'pulls/7': counted });
      const previous = await new GhForgeClient(config, runner).fetchByIid(7 as MergeRequestIid);
      if (previous === null) throw new Error('前回の結果が取れなかった');
      return previous;
    }

    it('PR 本体が前回と同じなら、PR 本体の 1 回だけで前回の結果を返す', async () => {
      // 変化の無い PR でコメント・コミットを毎回引き直すと、ポーリングのたびに PR の枚数の 4 倍以上を使う
      const previous = await firstFetch();
      const { runner, paths } = stubRunner({ 'pulls/7': counted });

      const snapshot = await new GhForgeClient(config, runner).fetchByIid(
        7 as MergeRequestIid,
        previous
      );

      expect(snapshot).toBe(previous);
      expect(paths).toEqual(['repos/iepyon/ai-board/pulls/7']);
    });

    it.each([
      ['コメントが増えた', { comments: 2 }],
      ['コード行への指摘が増えた', { review_comments: 1 }],
      ['push した', { head: { ref: 'feat/refresh-token', sha: 'cafebabe' } }],
      ['Draft に戻した', { draft: true }],
      ['マージした', { state: 'closed', merged_at: '2026-09-05T00:00:00Z' }],
      ['更新時刻が変わった', { updated_at: '2026-09-05T00:00:00Z' }],
    ])('%s なら詳細を引き直す', async (_label, change) => {
      const previous = await firstFetch();
      const { runner, paths } = stubRunner({
        'issues/7/comments': [{ created_at: '2026-09-05T10:00:00.000Z' }],
        'pulls/7': { ...counted, ...change },
      });

      const snapshot = await new GhForgeClient(config, runner).fetchByIid(
        7 as MergeRequestIid,
        previous
      );

      expect(snapshot).not.toBe(previous);
      expect(snapshot?.fingerprint).not.toBe(previous.fingerprint);
      expect(paths.length).toBeGreaterThan(1);
    });

    it('前回の結果が別の番号のものなら使い回さない', async () => {
      const previous = await firstFetch();
      const { runner } = stubRunner({ 'pulls/8': { ...counted, number: 8 } });

      const snapshot = await new GhForgeClient(config, runner).fetchByIid(
        8 as MergeRequestIid,
        previous
      );

      expect(snapshot?.mr.iid).toBe(8);
    });
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
  it('リポジトリを REST で引ければ null を返す', async () => {
    const { runner } = stubRunner({});

    expect(await new GhForgeClient(config, runner).checkAuth()).toBeNull();
  });

  it('gh auth status ではなく gh api でリポジトリを引く', async () => {
    const { runner, argv } = stubRunner({});

    await new GhForgeClient(config, runner).checkAuth();

    expect(argv).toEqual([['api', 'repos/iepyon/ai-board']]);
  });

  it('リポジトリを引けなければ理由を返す', async () => {
    const { runner } = stubRunner({}, ['repos/iepyon/ai-board']);

    expect(await new GhForgeClient(config, runner).checkAuth()).toContain('失敗した');
  });

  it('gh が無ければ理由を返す', async () => {
    const runner: CliRunner = {
      run: vi.fn(async () => err({ type: 'NotInstalled' as const, command: 'gh' })),
    };

    expect(await new GhForgeClient(config, runner).checkAuth()).toContain('見つからない');
  });
});
