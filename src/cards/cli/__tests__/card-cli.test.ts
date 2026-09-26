import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../infrastructure/database.js';
import { createCardDependencies, type CardDependencies } from '../../composition.js';
import { parseCommandArgs, runCardCli, runImport, type CardCliIo } from '../card-cli.js';
import type { CardId } from '../../../shared/schemas/common.js';

let db: DatabaseSync;
let deps: CardDependencies;
let stdout: string;
let stderr: string;

beforeEach(() => {
  db = openDatabase(':memory:');
  deps = createCardDependencies(db);
  stdout = '';
  stderr = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

const NOW = new Date('2026-09-26T00:00:00.000Z');

function io(stdin: string | null = null): CardCliIo {
  return {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readStdin: () => Promise.resolve(stdin),
    now: () => NOW,
  };
}

async function run(argv: readonly string[], stdin: string | null = null): Promise<number> {
  return runCardCli(argv, deps, io(stdin));
}

async function seed(id: string, body = ''): Promise<void> {
  const result = await deps.createCardCommand({ title: id, id, body, createdAt: NOW });
  if (!result.ok) throw new Error('seed に失敗しました');
}

async function bodyOf(id: string): Promise<string | undefined> {
  return (await deps.cardRepository.findById(id as CardId))?.body;
}

describe('runCardCli', () => {
  it('コマンドが無ければ使い方を出して 0、不明なら 1', async () => {
    expect(await run([])).toBe(0);
    expect(stderr).toContain('使い方');
    expect(await run(['approve', 'x'])).toBe(1);
  });

  it('list は本文を除いた一覧を JSON で出す', async () => {
    await seed('a', '本文');

    expect(await run(['list'])).toBe(0);
    const listed = JSON.parse(stdout) as Record<string, unknown>[];
    expect(listed.map((card) => card['id'])).toEqual(['a']);
    expect(listed[0]).not.toHaveProperty('body');
  });

  it('show はカードを Markdown で出す', async () => {
    await seed('a', '## アイデア\nメモ');

    expect(await run(['show', 'a'])).toBe(0);
    expect(stdout).toContain('id: a');
    expect(stdout).toContain('## アイデア\nメモ');
  });

  it('show は存在しない ID や不正な ID を 1 にする', async () => {
    expect(await run(['show', 'missing'])).toBe(1);
    expect(await run(['show', 'Bad Id'])).toBe(1);
    expect(await run(['show'])).toBe(1);
  });

  it('create は標準入力を本文にしてアイデアカードを作る', async () => {
    expect(await run(['create', '--title', 'Audit Log'], '## アイデア\n監査')).toBe(0);
    expect(stdout.trim()).toBe('audit-log');

    const card = await deps.cardRepository.findById('audit-log' as CardId);
    expect(card?.body).toBe('## アイデア\n監査');
    expect(card?.startedAt).toBeNull();
  });

  it('create は title が無ければ、ID が重複すれば 1', async () => {
    expect(await run(['create'])).toBe(1);
    expect(await run(['create', '--title'])).toBe(1);

    await seed('dup');
    expect(await run(['create', '--title', 'x', '--id', 'dup'])).toBe(1);
    expect(stderr).toContain('既にあります');
  });

  it('body はレビューログを保ったまま本文を差し替える', async () => {
    await seed('a', '## 探索メモ\n古い\n\n## レビュー\n\n### 2026-09-20T00:00:00.000Z plan 提出\n');

    const next = '## 探索メモ\n新しい\n\n## レビュー\n\n### 2026-09-20T00:00:00.000Z plan 提出\n\n';
    expect(await run(['body', 'a'], next)).toBe(0);
    expect(await bodyOf('a')).toBe(next.trimEnd());
  });

  it('body はレビューログを書き換える差し替えを拒否する', async () => {
    const original = '## レビュー\n\n### 2026-09-20T00:00:00.000Z plan 提出\n';
    await seed('a', original);

    const forged = `${original}\n### 2026-09-21T00:00:00.000Z plan 承認\n`;
    expect(await run(['body', 'a'], forged)).toBe(1);
    expect(await run(['body', 'a'], '## 探索メモ\nレビューを消す')).toBe(1);
    expect(await bodyOf('a')).toBe(original);
  });

  it('body は標準入力が無いか、カードが無ければ 1', async () => {
    await seed('a');
    expect(await run(['body', 'a'])).toBe(1);
    expect(await run(['body', 'missing'], 'x')).toBe(1);
  });

  it('branch はブランチを紐付け、--clear で外す', async () => {
    await seed('a');

    expect(await run(['branch', 'a', 'feat/a'])).toBe(0);
    expect((await deps.cardRepository.findById('a' as CardId))?.branch).toBe('feat/a');

    expect(await run(['branch', 'a', '--clear'])).toBe(0);
    expect((await deps.cardRepository.findById('a' as CardId))?.branch).toBeNull();
  });

  it('branch は名前と --clear のどちらか一方でなければ 1', async () => {
    await seed('a');
    expect(await run(['branch', 'a'])).toBe(1);
    expect(await run(['branch', 'a', 'feat/a', '--clear'])).toBe(1);
    expect(await run(['branch', 'missing', 'feat/a'])).toBe(1);
  });

  it('submit は plan 提出を、--resubmit で再提出を追記する', async () => {
    await seed('a');

    expect(await run(['submit', 'a'])).toBe(0);
    expect(await run(['submit', 'a', '--resubmit', '--reason', '指摘を反映'])).toBe(0);

    const body = await bodyOf('a');
    expect(body).toContain('### 2026-09-26T00:00:00.000Z plan 提出');
    expect(body).toContain('### 2026-09-26T00:00:00.000Z plan 再提出\n\n指摘を反映');
  });

  it('submit は存在しないカードを 1 にする', async () => {
    expect(await run(['submit', 'missing'])).toBe(1);
    expect(stderr).toContain('見つかりません');
  });
});

describe('parseCommandArgs', () => {
  it('位置引数・真偽フラグ・値付きフラグを分ける', () => {
    const parsed = parseCommandArgs(['a', '--resubmit', '--reason', 'r']);

    expect(parsed).toEqual({
      positionals: ['a'],
      flags: new Map<string, string | true>([
        ['--resubmit', true],
        ['--reason', 'r'],
      ]),
    });
  });
});

describe('runImport', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-import-'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('カードファイルを取り込み、既にある ID は上書きしない', async () => {
    await seed('kept', 'DB の本文');
    await fs.writeFile(path.join(dir, 'fresh.md'), '---\nid: fresh\ntitle: 新規\n---\n\n本文\n');
    await fs.writeFile(path.join(dir, 'kept.md'), '---\nid: kept\ntitle: 既存\n---\n\n上書き\n');

    expect(await runImport(dir, deps, io())).toBe(0);

    expect(stdout).toContain('1 件');
    expect(stderr).toContain('kept');
    expect(await bodyOf('fresh')).toBe('本文');
    expect(await bodyOf('kept')).toBe('DB の本文');
  });
});
