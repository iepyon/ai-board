import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { RefPlanRepository, countTasks } from '../plan.repository.js';
import { readPlanFilesAtCommit } from '../../../infrastructure/git-plan-tree.js';
import { createCliRunner } from '../../../infrastructure/cli-runner.js';
import { err, ok } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import { createStoreFixture, git, type StoreFixture } from '../../../__tests__/store-fixture.js';

// ============================================================
// fixture ヘルパー — コードのリポジトリの main に計画をコミットし、その参照から読む
// ============================================================

let fixture: StoreFixture;

beforeEach(() => {
  fixture = createStoreFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
  fixture.remove();
});

/** コードのリポジトリにファイルを書き、指定の時刻でコミットする */
async function commitFile(relativePath: string, content: string, at: string): Promise<void> {
  const target = path.join(fixture.repo, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf-8');
  git(fixture.repo, 'add', relativePath);
  execCommit(at);
}

function execCommit(at: string): void {
  execFileSync('git', ['commit', '--quiet', '-m', 'x'], {
    cwd: fixture.repo,
    env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
  });
}

/** コードのリポジトリの HEAD のコミット（置き場所の先頭にあたる）から読む。`commit` に null を渡せば置き場所が無い */
function repository(
  commit: string | null = git(fixture.repo, 'rev-parse', 'HEAD').trim()
): RefPlanRepository {
  return new RefPlanRepository(() =>
    readPlanFilesAtCommit({ runner: createCliRunner(), repoDir: fixture.repo, commit })
  );
}

// ============================================================
// チェックボックスの集計
// ============================================================

describe('countTasks', () => {
  it('チェックボックス行だけを数える', () => {
    const content = [
      '# 計画',
      '',
      '本文はタスクではない',
      '- [ ] やること',
      '- [x] やったこと',
    ].join('\n');

    expect(countTasks(content)).toEqual({ completed: 1, total: 2 });
  });

  it('インデントされたサブタスクも親と同じように数える', () => {
    expect(countTasks('- [x] 1\n  - [x] 1.1\n    - [ ] 1.1.1')).toEqual({ completed: 2, total: 3 });
  });

  it('箇条点とブラケットを詰めた書き方も拾う', () => {
    expect(countTasks('-[x] 詰めた\n*[ ] アスタリスク')).toEqual({ completed: 1, total: 2 });
  });

  it('大文字の X も完了として数える', () => {
    expect(countTasks('- [X] done')).toEqual({ completed: 1, total: 1 });
  });

  it('チェックボックスが 1 つも無ければ 0 件', () => {
    expect(countTasks('# 計画\n\n方針だけ書いた')).toEqual({ completed: 0, total: 0 });
  });
  it('フェンスで囲んだコードブロックの中のチェックボックスは数えない', () => {
    const content = [
      '## タスク',
      '- [x] 済んだ',
      '- [ ] 残り',
      '',
      '```markdown',
      '- [ ] 例 1',
      '- [ ] 例 2',
      '```',
      '',
      '- 箇条書きの中の例',
      '  ~~~',
      '  - [ ] 例 3',
      '  ~~~',
    ].join('\n');
    expect(countTasks(content)).toEqual({ completed: 1, total: 2 });
  });

  it('閉じていないフェンスの後ろのチェックボックスは数える', () => {
    expect(countTasks('- [x] 1\n```\n- [ ] 2')).toEqual({ completed: 1, total: 2 });
  });

  it('CRLF の改行でも数える', () => {
    expect(countTasks('- [x] 1\r\n```\r\n- [ ] 例\r\n```\r\n- [ ] 2')).toEqual({
      completed: 1,
      total: 2,
    });
  });
});

// ============================================================
// load()
// ============================================================

describe('RefPlanRepository.load', () => {
  it('置き場所のコミットが無ければ空を返す（例外にしない）', async () => {
    expect((await repository(null).load()).size).toBe(0);
  });

  it('参照の cards/<id>/plan.md を、main に入った計画（マージ済み）として読み、進捗を集計する', async () => {
    await commitFile(
      '.ai-board/cards/refresh-token/plan.md',
      '# 計画\n\n- [x] 1\n- [ ] 2',
      '2026-09-20T01:02:03Z'
    );

    const doc = (await repository().load()).get('refresh-token' as CardId);

    expect(doc?.tasks).toEqual({ completed: 1, total: 2 });
    expect(doc?.archived).toBe(true);
  });

  it('マージのコミットで入った計画は、ブランチの最後のコミットではなく、マージの時刻を updatedAt にする', async () => {
    await commitFile('README.md', 'x', '2026-09-01T00:00:00Z');
    git(fixture.repo, 'switch', '--quiet', '-c', 'feat/a');
    await commitFile('.ai-board/cards/a/plan.md', '- [x] 1', '2026-09-02T00:00:00Z');
    git(fixture.repo, 'switch', '--quiet', 'work');
    await commitFile('src/b.ts', '', '2026-09-03T00:00:00Z');
    execFileSync('git', ['merge', '--quiet', '--no-ff', '-m', 'マージ', 'feat/a'], {
      cwd: fixture.repo,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-09-10T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-09-10T00:00:00Z',
      },
    });

    expect((await repository().load()).get('a' as CardId)?.updatedAt).toBe(
      '2026-09-10T00:00:00.000Z'
    );
  });

  it('計画を最後に変えたコミットの時刻を updatedAt として返す', async () => {
    await commitFile('.ai-board/cards/refresh-token/plan.md', '- [ ] 1', '2026-09-20T01:02:03Z');
    await commitFile('.ai-board/cards/other/plan.md', '- [ ] 1', '2026-09-21T00:00:00Z');
    await commitFile('src/a.ts', '', '2026-09-22T00:00:00Z');

    const state = await repository().load();

    expect(state.get('refresh-token' as CardId)?.updatedAt).toBe('2026-09-20T01:02:03.000Z');
    expect(state.get('other' as CardId)?.updatedAt).toBe('2026-09-21T00:00:00.000Z');
  });

  it('作業ツリーの計画は読まない（チェックアウトがほかのブランチにいても main と取り違えない）', async () => {
    await commitFile('README.md', 'x', '2026-09-20T00:00:00Z');
    await fs.mkdir(path.join(fixture.repo, '.ai-board/cards/work'), { recursive: true });
    await fs.writeFile(path.join(fixture.repo, '.ai-board/cards/work/plan.md'), '- [ ] 1');

    expect((await repository().load()).size).toBe(0);
  });

  it('カードの計画のほかのファイル（card.md・log/・今の置き方の plans/）は読まない', async () => {
    await commitFile('.ai-board/cards/a/card.md', '---\nid: a\n---\n', '2026-09-20T00:00:00Z');
    await commitFile('.ai-board/plans/archive/b.md', '- [x] 1', '2026-09-20T00:00:00Z');

    expect((await repository().load()).size).toBe(0);
  });

  it('ディレクトリ名がカード ID として不正なら警告して読み飛ばす', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await commitFile('.ai-board/cards/Not_A_Card/plan.md', '- [ ] 1', '2026-09-20T00:00:00Z');

    expect((await repository().load()).size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('読めなければ警告して空を返す（ボードは開く）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failing = new RefPlanRepository(() => Promise.resolve(err('壊れている')));

    expect((await failing.load()).size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('壊れている'));
  });

  it('読み手の結果をそのまま計画にする', async () => {
    const repo = new RefPlanRepository(() =>
      Promise.resolve(
        ok([
          {
            path: '.ai-board/cards/x/plan.md',
            content: '- [ ] 1',
            committedAt: '2026-01-01T00:00:00.000Z',
          },
        ])
      )
    );

    expect((await repo.load()).get('x' as CardId)).toEqual({
      cardId: 'x',
      tasks: { completed: 0, total: 1 },
      archived: true,
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });
});
