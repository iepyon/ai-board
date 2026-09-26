import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsPlanRepository, countTasks } from '../plan.repository.js';
import type { CardId } from '../../../shared/schemas/common.js';

// ============================================================
// fixture ヘルパー
// ============================================================

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-plans-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function writeFile(relativePath: string, content: string): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf-8');
}

function repository(): FsPlanRepository {
  return new FsPlanRepository(path.join(root, '.ai-board', 'plans'));
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
});

// ============================================================
// load()
// ============================================================

describe('FsPlanRepository.load', () => {
  it('ディレクトリが無ければ空を返す（例外にしない）', async () => {
    expect((await repository().load()).size).toBe(0);
  });

  it('計画ファイルを読んで進捗を集計する', async () => {
    await writeFile('.ai-board/plans/refresh-token.md', '# 計画\n\n- [x] 1\n- [ ] 2');

    const state = await repository().load();
    const doc = state.get('refresh-token' as CardId);

    expect(doc?.tasks).toEqual({ completed: 1, total: 2 });
    expect(doc?.archived).toBe(false);
  });

  it('.md 以外とディレクトリは無視する', async () => {
    await writeFile('.ai-board/plans/notes.txt', 'x');
    await writeFile('.ai-board/plans/subdir/inner.md', 'x');

    expect((await repository().load()).size).toBe(0);
  });

  it('ファイル名がカード ID として不正なら警告して読み飛ばす', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await writeFile('.ai-board/plans/Not A Card.md', '- [ ] 1');

    expect((await repository().load()).size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  it('archive 配下は archived として読む', async () => {
    await writeFile('.ai-board/plans/archive/board-lanes.md', '- [x] 1');

    expect((await repository().load()).get('board-lanes' as CardId)?.archived).toBe(true);
  });

  it('同じカードが archive と直下の両方にあれば直下を採る', async () => {
    await writeFile('.ai-board/plans/archive/board-lanes.md', '- [x] 1');
    await writeFile('.ai-board/plans/board-lanes.md', '- [ ] 1\n- [ ] 2');

    const doc = (await repository().load()).get('board-lanes' as CardId);

    expect(doc?.archived).toBe(false);
    expect(doc?.tasks).toEqual({ completed: 0, total: 2 });
  });
});

// ============================================================
// readBody()
// ============================================================

describe('FsPlanRepository.readBody', () => {
  it('計画の本文を返す', async () => {
    await writeFile('.ai-board/plans/refresh-token.md', '# 計画\n\n本文');

    expect(await repository().readBody('refresh-token' as CardId)).toBe('# 計画\n\n本文');
  });

  it('archive 配下の計画も読める', async () => {
    await writeFile('.ai-board/plans/archive/board-lanes.md', '# 済んだ計画');

    expect(await repository().readBody('board-lanes' as CardId)).toBe('# 済んだ計画');
  });

  it('無ければ null を返す', async () => {
    expect(await repository().readBody('missing' as CardId)).toBeNull();
  });
});
