import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CardId } from '../../../shared/schemas/common.js';
import type { ChangeOp } from '../../models/change.js';
import { FsChangeFileRepository } from '../fs-change-file.repository.js';

let root: string;
let dir: string;
let repository: FsChangeFileRepository;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-changes-'));
  dir = path.join(root, 'changes');
  repository = new FsChangeFileRepository(dir);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const NOW = new Date('2026-09-27T07:15:00.123Z');

describe('FsChangeFileRepository', () => {
  it('置き場所が無ければ空を返す', async () => {
    expect(await repository.list()).toEqual([]);
  });

  it('時刻と乱数の名前で書き、読み戻せる（複数行の本文も崩れない）', async () => {
    const ops: ChangeOp[] = [
      {
        kind: 'card',
        id: 'a' as CardId,
        set: {
          title: 'コロン: を含む',
          created: '2026-09-27T00:00:00.000Z',
          body: '## アイデア\n\n- 箇条書き\n\n```yaml\nkey: value\n```',
          branch: null,
          skipGates: ['plan'],
        },
      },
      { kind: 'divider', rank: 1788504502903.5 },
    ];

    const name = await repository.write(ops, NOW);

    expect(name).toMatch(/^20260927T071500123Z-[0-9a-f]{4}\.yaml$/);
    expect(await repository.list()).toEqual([name]);
    expect(await repository.read(name)).toEqual({ ok: true, value: { name, ops } });
  });

  it('本文は YAML のブロックで書く（差分を読めるように）', async () => {
    const name = await repository.write(
      [{ kind: 'card', id: 'a' as CardId, set: { body: '1 行目\n2 行目' } }],
      NOW
    );

    expect(await fs.readFile(path.join(dir, name), 'utf-8')).toContain('body: |');
  });

  it('YAML 以外のファイルは無視し、名前の順に並べる', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'b.yaml'), '[]');
    await fs.writeFile(path.join(dir, 'a.yaml'), '[]');
    await fs.writeFile(path.join(dir, 'README.md'), '# 説明');

    expect(await repository.list()).toEqual(['a.yaml', 'b.yaml']);
  });

  it('空のファイルは操作なしとして読む', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'empty.yaml'), '');

    expect(await repository.read('empty.yaml')).toEqual({
      ok: true,
      value: { name: 'empty.yaml', ops: [] },
    });
  });

  it.each([
    ['知らない列', '- card: a\n  set:\n    color: red\n'],
    ['不正な ID', '- card: Not Valid\n  set:\n    title: A\n'],
    ['YAML として壊れている', '- card: [a\n'],
    ['操作の形が違う', '- delete: a\n'],
  ])('%s はエラーにする', async (_label, content) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'bad.yaml'), content);

    expect(await repository.read('bad.yaml')).toEqual({
      ok: false,
      error: { type: 'ChangeFileMalformed', file: 'bad.yaml', reason: expect.any(String) },
    });
  });
});
