import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../infrastructure/database.js';
import { createCardDependencies } from '../../../cards/composition.js';
import { parseCard } from '../../../cards/repositories/card-markdown.js';
import { SqliteCardRepository } from '../../../cards/repositories/sqlite-card.repository.js';
import { createBoardDependencies } from '../../composition.js';
import type { MrStateProvider } from '../../services/mr-state-provider.js';
import type { ForgeConnection } from '../../models/mr-state.js';
import { runStatusCli, type StatusReport } from '../status-cli.js';

// ============================================================
// テスト用プロジェクトの組み立て
// ============================================================

let root: string;
let db: DatabaseSync;
let stdout: string;
let stderr: string;

const NOW = new Date('2026-10-23T00:00:00.000Z');

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-status-'));
  db = openDatabase(':memory:');
  stdout = '';
  stderr = '';
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await fs.rm(root, { recursive: true, force: true });
});

async function writeCard(id: string, frontmatter: string, body = ''): Promise<void> {
  const card = parseCard(
    `${id}.md`,
    `---\nid: ${id}\ntitle: ${id} のタイトル\n${frontmatter}---\n${body}`
  );
  if (card === null) throw new Error(`テスト用のカードが読めません: ${id}`);
  await new SqliteCardRepository(db).create(card);
}

async function writePlan(id: string, content: string): Promise<void> {
  const target = path.join(root, '.ai-board', 'plans', `${id}.md`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf-8');
}

function review(kind: string): string {
  return `## レビュー\n\n### 2026-10-20T00:00:00.000Z plan ${kind}\n`;
}

function stubProvider(
  connection: ForgeConnection = { status: 'connected', kind: 'github' }
): MrStateProvider {
  return { get: () => null, connection: () => connection };
}

async function run(argv: readonly string[], provider = stubProvider()): Promise<number> {
  const cards = createCardDependencies(db);
  const board = createBoardDependencies(
    path.join(root, '.ai-board', 'plans'),
    cards.cardRepository,
    cards.ideaDividerRepository,
    provider
  );

  return runStatusCli(argv, board, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    now: () => NOW,
  });
}

async function runJson(provider?: MrStateProvider): Promise<StatusReport> {
  expect(await run(['--json'], provider)).toBe(0);
  return JSON.parse(stdout) as StatusReport;
}

// ============================================================
// --json
// ============================================================

describe('ai-board status --json', () => {
  it('次の一手・判断待ち・カード・接続状態を出す', async () => {
    await writeCard('started', "startedAt: '2026-10-22T00:00:00.000Z'\n");
    await writeCard('reviewing', "startedAt: '2026-10-21T00:00:00.000Z'\n", review('提出'));
    await writePlan('reviewing', '# 計画\n\n- [ ] 1');
    await writeCard('idea', '');

    const report = await runJson();

    expect(report.next).toEqual({
      cardId: 'started',
      action: 'plan',
      reason: '着手が指示され、計画がまだ無い',
    });
    expect(report.waiting.map((card) => [card.id, card.stage])).toEqual([
      ['reviewing', 'plan-review'],
    ]);
    expect(report.cards.map((card) => card.id).sort()).toEqual(['idea', 'reviewing', 'started']);
    expect(report.forge).toEqual({ status: 'connected', kind: 'github' });
  });

  it('カードの本文は出さない', async () => {
    await writeCard(
      'started',
      "startedAt: '2026-10-22T00:00:00.000Z'\n",
      '## アイデア\n\n長い本文'
    );

    const report = await runJson();

    expect(report.cards[0]).not.toHaveProperty('body');
  });

  it('提出したのに成果物の見えないカードは次の一手にせず、判断待ちに理由付きで出す', async () => {
    await writeCard('lost', "startedAt: '2026-10-22T00:00:00.000Z'\n", review('提出'));

    const report = await runJson();

    expect(report.next).toBeNull();
    expect(report.waiting).toEqual([
      {
        id: 'lost',
        title: 'lost のタイトル',
        stage: 'planning',
        reason: '計画を提出済みだが、計画ファイルも Draft の PR も見えない',
      },
    ]);
  });

  it('GitHub が使えないときは接続状態に理由を載せる', async () => {
    const report = await runJson(
      stubProvider({ status: 'disabled', kind: 'github', reason: 'gh にログインしていません' })
    );

    expect(report.forge).toEqual({
      status: 'disabled',
      kind: 'github',
      reason: 'gh にログインしていません',
    });
  });
});

// ============================================================
// 人向けの出力
// ============================================================

describe('ai-board status', () => {
  it('判断待ち / AI 作業中 / 次の一手 を数行で出す', async () => {
    await writeCard('impl', "startedAt: '2026-10-01T00:00:00.000Z'\n", review('承認'));
    await writeCard('reviewing', "startedAt: '2026-10-21T00:00:00.000Z'\n", review('提出'));
    await writePlan('reviewing', '# 計画');

    expect(await run([])).toBe(0);

    expect(stdout).toContain('GitHub: 接続済み');
    expect(stdout).toContain('判断待ち (1)');
    expect(stdout).toContain('reviewing  [計画レビュー]  reviewing のタイトル');
    expect(stdout).toContain('AI 作業中 (1)');
    // 計画ファイルが無いので着手の時刻から数え、3 日以上たっている
    expect(stdout).toContain('impl  [実装中]  impl のタイトル  ※ 動きなし');
    expect(stdout).toContain('次の一手: implement impl（計画が承認されている）');
  });

  it('進められるカードが無ければ、次の一手は なし', async () => {
    expect(await run([], stubProvider({ status: 'disabled', kind: null, reason: null }))).toBe(0);

    expect(stdout).toContain('GitHub: 未設定');
    expect(stdout).toContain('次の一手: なし');
  });
});

// ============================================================
// 引数
// ============================================================

describe('ai-board status の引数', () => {
  it('--help は使い方を出して 0 で終わる', async () => {
    expect(await run(['--help'])).toBe(0);
    expect(stderr).toContain('使い方: ai-board status');
  });

  it('不明な引数は使い方を出して 1 で終わる', async () => {
    expect(await run(['--yaml'])).toBe(1);
    expect(stderr).toContain('使い方: ai-board status');
    expect(stdout).toBe('');
  });
});
