import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FsOpenSpecRepository,
  countTasks,
  stripArchiveDatePrefix,
} from '../openspec.repository.js';

// ============================================================
// fixture ヘルパー
// ============================================================

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-openspec-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeFile(relativePath: string, content: string): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf-8');
}

function repository(): FsOpenSpecRepository {
  return new FsOpenSpecRepository(path.join(root, 'openspec'));
}

// ============================================================
// tasks.md のパース
// ============================================================

describe('countTasks', () => {
  it('チェックボックス行だけを数える', () => {
    const content = [
      '## 1. セットアップ',
      '',
      '- [x] 1.1 依存を入れる',
      '- [ ] 1.2 設定を書く',
      '* [X] 1.3 アスタリスクと大文字も数える',
      '',
      '- これはタスクではない',
      '通常の段落',
    ].join('\n');

    expect(countTasks(content)).toEqual({ completed: 2, total: 3 });
  });

  it('インデントされたサブタスクも親と同じように数える', () => {
    const content = [
      '- [x] 1. 親タスク',
      '  - [x] 1.1 サブタスク',
      '  - [ ] 1.2 サブタスク',
      '\t- [ ] 1.3 タブインデント',
    ].join('\n');

    expect(countTasks(content)).toEqual({ completed: 2, total: 4 });
  });

  it('箇条点とチェックボックスの間に空白が無くても数える', () => {
    expect(countTasks('-[x] 詰めて書かれたタスク')).toEqual({ completed: 1, total: 1 });
  });

  it('タスクが 1 つも無ければ 0 件', () => {
    expect(countTasks('# 見出しだけ\n\n本文')).toEqual({ completed: 0, total: 0 });
  });
});

describe('stripArchiveDatePrefix', () => {
  it('日付プレフィックスを取り除く', () => {
    expect(stripArchiveDatePrefix('2026-09-01-refresh-token')).toBe('refresh-token');
  });

  it('日付が無い名前はそのまま返す', () => {
    expect(stripArchiveDatePrefix('refresh-token')).toBe('refresh-token');
  });

  it('change 名の中の数字は消さない', () => {
    expect(stripArchiveDatePrefix('2026-09-01-migrate-v2-schema')).toBe('migrate-v2-schema');
  });
});

// ============================================================
// ディレクトリ走査
// ============================================================

describe('FsOpenSpecRepository', () => {
  it('openspec ディレクトリが無ければ空を返す', async () => {
    expect((await repository().load()).size).toBe(0);
  });

  it('artifact の完了をファイル存在で判定する', async () => {
    await writeFile('openspec/changes/refresh-token/proposal.md', '# Why');
    await writeFile('openspec/changes/refresh-token/tasks.md', '- [x] 1.1 done\n- [ ] 1.2 todo');
    await writeFile('openspec/changes/refresh-token/specs/auth/spec.md', '# spec');

    const state = await repository().load();
    const change = state.get('refresh-token');

    expect(change?.artifacts).toEqual({
      proposal: true,
      specs: true,
      design: false,
      tasks: true,
    });
    expect(change?.tasks).toEqual({ completed: 1, total: 2 });
    expect(change?.archived).toBe(false);
  });

  it('specs は入れ子のディレクトリでも検出する', async () => {
    await writeFile('openspec/changes/deep/specs/a/b/c/spec.md', '# spec');

    const state = await repository().load();

    expect(state.get('deep')?.artifacts.specs).toBe(true);
  });

  it('specs ディレクトリに md が無ければ未完了', async () => {
    await writeFile('openspec/changes/empty-specs/specs/README.txt', 'not markdown');

    const state = await repository().load();

    expect(state.get('empty-specs')?.artifacts.specs).toBe(false);
  });

  it('archive の change を日付プレフィックスを外した名前で登録する', async () => {
    await writeFile('openspec/changes/archive/2026-09-01-login-redesign/proposal.md', '# Why');

    const state = await repository().load();
    const change = state.get('login-redesign');

    expect(change?.archived).toBe(true);
    expect(change?.archivedAs).toBe('2026-09-01-login-redesign');
  });

  it('archive ディレクトリ自体は change として扱わない', async () => {
    await writeFile('openspec/changes/archive/2026-09-01-done-change/proposal.md', '# Why');
    await writeFile('openspec/changes/active-change/proposal.md', '# Why');

    const state = await repository().load();

    expect(state.has('archive')).toBe(false);
    expect([...state.keys()].sort()).toEqual(['active-change', 'done-change']);
  });

  it('archive と同名の change が作り直されたら active を優先する', async () => {
    await writeFile('openspec/changes/archive/2026-09-01-refresh-token/proposal.md', '# 旧');
    await writeFile('openspec/changes/refresh-token/proposal.md', '# 新');

    const state = await repository().load();

    expect(state.get('refresh-token')?.archived).toBe(false);
  });

  it('tasks.md が無ければ進捗は 0 件', async () => {
    await writeFile('openspec/changes/no-tasks/proposal.md', '# Why');

    const state = await repository().load();

    expect(state.get('no-tasks')?.tasks).toEqual({ completed: 0, total: 0 });
  });
});
