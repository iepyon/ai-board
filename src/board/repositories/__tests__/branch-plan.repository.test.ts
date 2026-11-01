import { describe, it, expect } from 'vitest';
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
const activePath = '.ai-board/plans/some-card.md';
const archivePath = '.ai-board/plans/archive/some-card.md';

// ============================================================
// GitBranchPlanRepository
// ============================================================

describe('GitBranchPlanRepository', () => {
  it('ローカルのブランチの plans/ の計画を本文ごと返す', async () => {
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

  it('plans/ に無く plans/archive/ にあれば archived を返す', async () => {
    const { runner } = fakeGit({
      refs: [localRef],
      blobs: { [`${localRef}:${archivePath}`]: 'archived' },
    });

    const plan = await new GitBranchPlanRepository(runner, ROOT).find(cardId, 'feat/x');

    expect(plan).toEqual({ location: 'archived' });
  });

  it('plans/ と plans/archive/ の両方にあれば plans/ を採る', async () => {
    const { runner } = fakeGit({
      refs: [localRef],
      blobs: { [`${localRef}:${activePath}`]: 'active', [`${localRef}:${archivePath}`]: 'old' },
    });

    const plan = await new GitBranchPlanRepository(runner, ROOT).find(cardId, 'feat/x');

    expect(plan).toEqual({ location: 'active', text: 'active' });
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
