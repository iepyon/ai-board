import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isErr, ok } from '../../../shared/result.js';
import { createCliRunner } from '../../../infrastructure/cli-runner.js';
import { initialDocuments } from '../../../infrastructure/document-store.js';
import { changedStoreFiles } from '../../../infrastructure/git-branch-check.js';
import type { GitDocumentStore } from '../../../infrastructure/git-document-store.js';
import {
  createGitStoreFixture,
  git,
  initializedStore,
  type GitStoreFixture,
} from '../../../__tests__/git-store-fixture.js';
import { isStoreFilePath } from '../../repositories/card-file-codec.js';
import {
  isStoreCommand,
  runStoreCli,
  STORE_USAGE,
  type StoreCliDependencies,
} from '../store-cli.js';

let fixture: GitStoreFixture;
let store: GitDocumentStore;
let stdout: string;
let stderr: string;
let seedCalls: string[];

beforeEach(() => {
  fixture = createGitStoreFixture();
  store = fixture.open();
  stdout = '';
  stderr = '';
  seedCalls = [];
});

afterEach(() => {
  fixture.remove();
});

/** `cli-main.ts` の組み立てと同じ依存。置き場所は一時の bare リポジトリ */
function deps(): StoreCliDependencies {
  return {
    initialize: () => store.initialize(initialDocuments()),
    runSeed: (dir) => {
      seedCalls.push(dir);
      return Promise.resolve(0);
    },
    seedDir: '/repo/.ai-board/seed',
    checkBranch: async (branch) => {
      const checked = await store.check();
      if (isErr(checked)) return checked;
      return changedStoreFiles({
        runner: createCliRunner(),
        repoDir: fixture.repo,
        branch,
        isStoreFile: isStoreFilePath,
      });
    },
  };
}

function run(argv: readonly string[]): Promise<number> {
  return runStoreCli(argv, deps(), {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
}

describe('runStoreCli', () => {
  it('引数が無い・--help なら使い方を出して 0', async () => {
    expect(await run([])).toBe(0);
    expect(await run(['init', '--help'])).toBe(0);
    expect(stderr).toContain(STORE_USAGE);
  });

  it('消したコマンドは不明なコマンドとして 1', async () => {
    for (const command of ['pull', 'outbox', 'ack', 'discard', 'import']) {
      expect(isStoreCommand(command)).toBe(false);
      expect(await run([command])).toBe(1);
    }
    expect(stderr).toContain('不明なコマンドです: outbox');
  });

  describe('init', () => {
    it('空の置き場所に形の版を書いて push し、2 度目は拒む', async () => {
      expect(await run(['init'])).toBe(0);
      expect(fixture.files()).toEqual(['.ai-board/board.yaml']);
      expect(fixture.show('.ai-board/board.yaml')).toBe('version: 3\n');

      expect(await run(['init'])).toBe(1);
      expect(stderr).toContain('既に始まっています');
    });
  });

  describe('seed', () => {
    it('既定は seedDir、--from で別のディレクトリを渡す', async () => {
      expect(await run(['seed'])).toBe(0);
      expect(await run(['seed', '--from', 'other'])).toBe(0);
      expect(seedCalls).toEqual(['/repo/.ai-board/seed', 'other']);
    });

    it('--from に値が無ければ 1', async () => {
      expect(await run(['seed', '--from'])).toBe(1);
      expect(seedCalls).toEqual([]);
    });
  });

  describe('check-branch', () => {
    /** 置き場所の先頭からカードのブランチを作り、ファイルを書いてコミットする */
    function branchFrom(name: string, files: Record<string, string>): void {
      git(fixture.repo, 'checkout', '--quiet', '-B', name, 'refs/ai-board/store');
      for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(fixture.repo, file)), { recursive: true });
        fs.writeFileSync(path.join(fixture.repo, file), content);
        git(fixture.repo, 'add', file);
      }
      git(fixture.repo, 'commit', '--quiet', '-m', `${name} の変更`);
    }

    beforeEach(async () => {
      store = await initializedStore(fixture);
    });

    it('置き場所のファイルを変えたブランチは、ファイルを並べて 1', async () => {
      branchFrom('feat/bad', {
        '.ai-board/cards/a/card.md': '---\nid: a\n---\n',
        '.ai-board/cards/a/plan.md': '# 計画\n',
      });

      expect(await run(['check-branch', 'feat/bad'])).toBe(1);
      expect(stderr).toContain('.ai-board/cards/a/card.md');
      expect(stderr).not.toContain('plan.md');
    });

    it('計画とコードだけを変えたブランチは 0', async () => {
      branchFrom('feat/good', { '.ai-board/cards/a/plan.md': '# 計画\n', 'src/a.ts': '' });

      expect(await run(['check-branch', 'feat/good'])).toBe(0);
      expect(stdout).toContain('変えていません');
    });

    it('置き場所のファイルを変えた main を取り込んだだけのブランチは 0（分岐点からの差分で見る）', async () => {
      branchFrom('feat/merge', { '.ai-board/cards/a/plan.md': '# 計画\n' });
      await store.transact('並び順を変える', () => {
        store.set('order', 'order', { divider: null, ranks: { a: 1 } });
        return Promise.resolve(ok(undefined));
      });
      git(fixture.repo, 'fetch', '--quiet', fixture.bare, '+refs/heads/main:refs/ai-board/store');
      git(fixture.repo, 'merge', '--quiet', '--no-edit', 'refs/ai-board/store');

      expect(await run(['check-branch', 'feat/merge'])).toBe(0);
    });

    it('ブランチが無い、- で始まる名前は 1', async () => {
      expect(await run(['check-branch', 'missing'])).toBe(1);
      expect(stderr).toContain('見つかりません');

      stderr = '';
      expect(await run(['check-branch', '--output=x'])).toBe(1);
      expect(stderr).toContain('ブランチを 1 つ指定');
    });
  });
});
