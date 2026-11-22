import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCliRunner } from '../../../infrastructure/cli-runner.js';
import type { CliError, CliRunner } from '../../../infrastructure/cli-runner.js';
import { err, ok, type Result } from '../../../shared/result.js';
import { createCardId } from '../../../shared/schemas/common.js';
import { GitBranchPlanRepository } from '../branch-plan.repository.js';

// ============================================================
// 偽の git
// ============================================================

const ROOT = '/repo';
const cardId = createCardId('some-card');

const failed: CliError = { type: 'Failed', command: 'git', message: '失敗', httpStatus: null };

interface FakeGit {
  /** 在るとみなす ref（`refs/heads/x` など） */
  readonly refs?: readonly string[];
  /** `<ref>:<path>` → 中身 */
  readonly blobs?: Readonly<Record<string, string>>;
  /** check-ref-format が返す名前を差し替える（`@{-1}` の展開を真似る） */
  readonly expand?: (branch: string) => string;
  /** check-ref-format を落とす名前 */
  readonly invalid?: readonly string[];
}

function fakeGit(fake: FakeGit): { runner: CliRunner; calls: string[][] } {
  const calls: string[][] = [];

  const runner: CliRunner = {
    run: async (command, args): Promise<Result<string, CliError>> => {
      calls.push([command, ...args]);
      expect(command).toBe('git');
      expect(args.slice(0, 2)).toEqual(['-C', ROOT]);

      const [sub = '', ...rest] = args.slice(2);
      return respond(fake, sub, rest.at(-1) ?? '');
    },
  };

  return { runner, calls };
}

/** `last` はサブコマンドの最後の引数（ブランチ名・ref・`<ref>:<path>`） */
function respond(fake: FakeGit, sub: string, last: string): Result<string, CliError> {
  switch (sub) {
    case 'check-ref-format':
      if (fake.invalid?.includes(last)) return err(failed);
      return ok(`${fake.expand?.(last) ?? last}\n`);
    case 'rev-parse':
      return fake.refs?.includes(last) ? ok('0123abcd\n') : err(failed);
    case 'show': {
      const blob = fake.blobs?.[last];
      return blob === undefined ? err(failed) : ok(blob);
    }
    default:
      return err(failed);
  }
}

const localRef = 'refs/heads/feat/x';
const remoteRef = 'refs/remotes/origin/feat/x';
const activePath = '.ai-board/cards/some-card/plan.md';

// ============================================================
// GitBranchPlanRepository
// ============================================================

describe('GitBranchPlanRepository', () => {
  it('ローカルのブランチの cards/<id>/plan.md を本文ごと返す', async () => {
    const { runner, calls } = fakeGit({
      refs: [localRef, remoteRef],
      blobs: { [`${localRef}:${activePath}`]: 'local', [`${remoteRef}:${activePath}`]: 'remote' },
    });

    const plan = await new GitBranchPlanRepository(runner, ROOT).find(cardId, 'feat/x');

    expect(plan).toEqual({ location: 'active', text: 'local' });
    expect(calls).toContainEqual([
      'git',
      '-C',
      ROOT,
      'show',
      '--no-textconv',
      `${localRef}:${activePath}`,
    ]);
  });

  it('ローカルのブランチが無ければ origin の追跡ブランチを読む', async () => {
    const { runner } = fakeGit({
      refs: [remoteRef],
      blobs: { [`${remoteRef}:${activePath}`]: 'remote' },
    });

    const plan = await new GitBranchPlanRepository(runner, ROOT).find(cardId, 'feat/x');

    expect(plan).toEqual({ location: 'active', text: 'remote' });
  });

  it('ローカルのブランチがあれば、そこに計画が無くても origin へは落ちない', async () => {
    const { runner } = fakeGit({
      refs: [localRef, remoteRef],
      blobs: { [`${remoteRef}:${activePath}`]: 'remote' },
    });

    const plan = await new GitBranchPlanRepository(runner, ROOT).find(cardId, 'feat/x');

    expect(plan).toBeNull();
  });

  it('計画に ## 締め の節があれば closed を返す', async () => {
    const { runner } = fakeGit({
      refs: [localRef],
      blobs: { [`${localRef}:${activePath}`]: '# 計画\n\n- [x] 1\n\n## 締め\n\n2026-11-22\n' },
    });

    const plan = await new GitBranchPlanRepository(runner, ROOT).find(cardId, 'feat/x');

    expect(plan).toEqual({ location: 'closed' });
  });

  it('コードブロックの中の ## 締め は締め済みと読まない', async () => {
    const text = '# 計画\n\n```markdown\n## 締め\n```\n';
    const { runner } = fakeGit({
      refs: [localRef],
      blobs: { [`${localRef}:${activePath}`]: text },
    });

    const plan = await new GitBranchPlanRepository(runner, ROOT).find(cardId, 'feat/x');

    expect(plan).toEqual({ location: 'active', text });
  });

  it('リモートを渡せば、そのリモートの追跡ブランチを読む', async () => {
    const upstream = 'refs/remotes/upstream/feat/x';
    const { runner } = fakeGit({
      refs: [upstream],
      blobs: { [`${upstream}:${activePath}`]: 'up' },
    });

    const plan = await new GitBranchPlanRepository(runner, ROOT, 'upstream').find(cardId, 'feat/x');

    expect(plan).toEqual({ location: 'active', text: 'up' });
  });

  it('ブランチがどこにも無ければ null を返し、git show を呼ばない', async () => {
    const { runner, calls } = fakeGit({});

    const plan = await new GitBranchPlanRepository(runner, ROOT).find(cardId, 'feat/x');

    expect(plan).toBeNull();
    expect(calls.some((call) => call[3] === 'show')).toBe(false);
  });

  it('計画がどちらにも無ければ null を返す', async () => {
    const { runner } = fakeGit({ refs: [localRef] });

    const plan = await new GitBranchPlanRepository(runner, ROOT).find(cardId, 'feat/x');

    expect(plan).toBeNull();
  });

  it('git が見つからなくても例外を投げず null を返す', async () => {
    const runner: CliRunner = {
      run: async () => err({ type: 'NotInstalled', command: 'git' }),
    };

    const plan = await new GitBranchPlanRepository(runner, ROOT).find(cardId, 'feat/x');

    expect(plan).toBeNull();
  });

  it('check-ref-format を通らない名前では check-ref-format のほかに git を呼ばない', async () => {
    const { runner, calls } = fakeGit({
      refs: ['refs/heads/a..b'],
      invalid: ['a..b'],
    });

    const plan = await new GitBranchPlanRepository(runner, ROOT).find(cardId, 'a..b');

    expect(plan).toBeNull();
    expect(calls).toEqual([['git', '-C', ROOT, 'check-ref-format', '--branch', 'a..b']]);
  });

  it.each(['-c', '--output=/tmp/x', ''])(
    '名前 %j は git を呼ばずに null を返す',
    async (branch) => {
      const { runner, calls } = fakeGit({ refs: [`refs/heads/${branch}`] });

      const plan = await new GitBranchPlanRepository(runner, ROOT).find(cardId, branch);

      expect(plan).toBeNull();
      expect(calls).toEqual([]);
    }
  );

  it('check-ref-format が別の名前へ展開した（@{-1} など）ときは読まない', async () => {
    const { runner, calls } = fakeGit({
      refs: [localRef],
      blobs: { [`${localRef}:${activePath}`]: 'local' },
      expand: () => 'feat/x',
    });

    const plan = await new GitBranchPlanRepository(runner, ROOT).find(cardId, '@{-1}');

    expect(plan).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

// ============================================================
// GitBranchPlanRepository.findActive（一時の git リポジトリで）
// ============================================================

describe('GitBranchPlanRepository.findActive', () => {
  let repo: string;
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' });

  async function commitFile(file: string, text: string, message: string): Promise<void> {
    await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await fs.writeFile(path.join(repo, file), text, 'utf-8');
    git('add', file);
    git('commit', '-q', '-m', message);
  }

  beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'branch-plan-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    await commitFile('README.md', '# repo\n', 'init');

    git('switch', '-q', '-c', 'active-card');
    await commitFile(
      '.ai-board/cards/active-card/plan.md',
      '# 計画\n\n- [x] 1\n- [ ] 2\n',
      '計画を立てる'
    );

    git('switch', '-q', 'main');
    git('switch', '-q', '-c', 'old-layout');
    await commitFile('.ai-board/plans/old-layout.md', '# 計画\n', '今の置き方の計画');
    git('switch', '-q', 'main');
  });

  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  const reader = () => new GitBranchPlanRepository(createCliRunner(), repo);

  it('ブランチの cards/<id>/plan.md を、タスクの数とコミットの時刻を付けて返す', async () => {
    const doc = await reader().findActive(createCardId('active-card'), 'active-card');
    const committedAt = git('log', '-1', '--format=%cI', 'active-card').trim();

    expect(doc).toEqual({
      cardId: 'active-card',
      tasks: { completed: 1, total: 2 },
      archived: false,
      updatedAt: new Date(committedAt).toISOString(),
    });
  });

  it('今の置き方（plans/<id>.md）の計画は読まない', async () => {
    expect(await reader().findActive(createCardId('old-layout'), 'old-layout')).toBeNull();
  });

  it('ブランチが無い・名前が不正なら null', async () => {
    expect(await reader().findActive(createCardId('active-card'), 'missing')).toBeNull();
    expect(await reader().findActive(createCardId('active-card'), '-x')).toBeNull();
  });
});

describe('GitBranchPlanRepository.findClosed', () => {
  let repo: string;
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf-8' });

  async function commitFile(file: string, text: string, message: string): Promise<void> {
    await fs.mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await fs.writeFile(path.join(repo, file), text, 'utf-8');
    git('add', file);
    git('commit', '-q', '-m', message);
  }

  beforeAll(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), 'branch-closed-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    await commitFile('README.md', '# repo\n', 'init');

    // 締めが済んだブランチ: 計画を立て、締めの段が ## 締め の節を足した
    git('switch', '-q', '-c', 'closed-card');
    await commitFile('.ai-board/cards/closed-card/plan.md', '# 計画\n- [x] 1\n', '計画を立てる');
    await commitFile(
      '.ai-board/cards/closed-card/plan.md',
      '# 計画\n- [x] 1\n\n## 締め\n\n2026-11-22\n',
      '締める'
    );
    git('switch', '-q', 'main');

    git('switch', '-q', '-c', 'active-card');
    await commitFile('.ai-board/cards/active-card/plan.md', '# 計画\n- [ ] 1\n', '計画を立てる');
    git('switch', '-q', 'main');
  });

  afterAll(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  const reader = () => new GitBranchPlanRepository(createCliRunner(), repo);

  it('ブランチの計画に ## 締め の節があれば、計画を最後に変えたコミットの時刻を返す', async () => {
    const closed = await reader().findClosed(createCardId('closed-card'), 'closed-card');
    const committedAt = git('log', '-1', '--format=%cI', 'closed-card').trim();

    expect(closed).toEqual({ closedAt: new Date(committedAt).toISOString() });
  });

  it('ブランチの計画に ## 締め の節が無ければ（締めの前）null', async () => {
    expect(await reader().findClosed(createCardId('active-card'), 'active-card')).toBeNull();
  });

  it('ブランチが無い・名前が不正・計画がどこにも無ければ null', async () => {
    expect(await reader().findClosed(createCardId('closed-card'), 'missing')).toBeNull();
    expect(await reader().findClosed(createCardId('closed-card'), '-x')).toBeNull();
    expect(await reader().findClosed(createCardId('other-card'), 'closed-card')).toBeNull();
  });
});
