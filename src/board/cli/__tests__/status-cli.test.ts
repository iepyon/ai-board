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
import { HOLD_REASONS } from '../../services/next-action.js';
import type { ServerLocation } from '../../../infrastructure/server-info.js';
import { parseStatusArgs, runStatusCli, type StatusReport } from '../status-cli.js';

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
  return { get: () => null, connection: () => connection, synced: () => true };
}

async function run(
  argv: readonly string[],
  provider = stubProvider(),
  findServer?: () => ServerLocation | null
): Promise<number> {
  const cards = createCardDependencies(db);
  const board = createBoardDependencies(
    path.join(root, '.ai-board', 'plans'),
    cards.cardRepository,
    cards.ideaDividerRepository,
    provider
  );

  return runStatusCli(
    argv,
    { ...board, ...(findServer ? { findServer } : {}) },
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      now: () => NOW,
    }
  );
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

  it('カードごとに区間の並び（timeline）を出す', async () => {
    await writeCard(
      'reviewing',
      "created: '2026-10-19T00:00:00.000Z'\nstartedAt: '2026-10-19T12:00:00.000Z'\n",
      review('提出')
    );
    await writePlan('reviewing', '# 計画\n\n- [ ] 1');

    const report = await runJson();

    expect(report.cards[0]?.timeline).toEqual([
      {
        kind: 'idea',
        owner: 'human',
        start: '2026-10-19T00:00:00.000Z',
        end: '2026-10-19T12:00:00.000Z',
      },
      {
        kind: 'planning',
        owner: 'ai',
        start: '2026-10-19T12:00:00.000Z',
        end: '2026-10-20T00:00:00.000Z',
      },
      { kind: 'plan-review', owner: 'human', start: '2026-10-20T00:00:00.000Z', end: null },
    ]);
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
        // 直させる先の計画が見えないので、中止だけ
        decisions: [{ gate: 'plan', kind: '中止', label: '中止する', reasonRequired: false }],
      },
    ]);
  });

  it('取得先に接続できなければ、提出したのに成果物の見えないカードを判断待ちに出さない', async () => {
    await writeCard('lost', "startedAt: '2026-10-22T00:00:00.000Z'\n", review('提出'));

    const report = await runJson(
      stubProvider({ status: 'error', kind: 'github', message: 'gh が落ちた' })
    );

    expect(report.waiting).toEqual([]);
  });

  it('作業者が保留を書いて止まったカードは、判断待ちに 1 度だけ出し、飛ばして後ろのカードを選ぶ', async () => {
    await writeCard(
      'held',
      "startedAt: '2026-10-20T00:00:00.000Z'\nrank: 1\n",
      `${review('承認')}\n### 2026-10-21T00:00:00.000Z verify 否決\n\n検索が遅い\n\n### 2026-10-22T00:00:00.000Z verify 保留\n\n直すには大きすぎる\n`
    );
    await writeCard('started', "startedAt: '2026-10-22T00:00:00.000Z'\nrank: 2\n");

    const report = await runJson();

    expect(report.next).toEqual({
      cardId: 'started',
      action: 'plan',
      reason: '着手が指示され、計画がまだ無い',
    });
    expect(report.waiting).toEqual([
      {
        id: 'held',
        title: 'held のタイトル',
        stage: 'impling',
        reason: HOLD_REASONS.verifyHeld,
        decisions: [
          { gate: 'verify', kind: '否決', label: '実装を直させる', reasonRequired: true },
          { gate: 'plan', kind: '否決', label: '計画から立て直させる', reasonRequired: true },
          { gate: 'verify', kind: '中止', label: '中止する', reasonRequired: false },
        ],
      },
    ]);
    expect(report.working.map((card) => card.id)).toEqual(['started']);
    expect(report.cards.find((card) => card.id === 'held')?.hold).toEqual({
      reason: HOLD_REASONS.verifyHeld,
      since: '2026-10-22T00:00:00.000Z',
    });
  });

  it('動作確認を待つカードは判断待ちに出し、次の一手にしない', async () => {
    await writeCard(
      'verifying',
      "startedAt: '2026-10-21T00:00:00.000Z'\n",
      `${review('承認')}\n### 2026-10-22T00:00:00.000Z verify 提出\n`
    );

    const report = await runJson();

    expect(report.next).toBeNull();
    expect(report.waiting).toEqual([
      {
        id: 'verifying',
        title: 'verifying のタイトル',
        stage: 'verifying',
        reason: '実装が人の動作確認を待っている',
        decisions: [
          { gate: 'verify', kind: '承認', label: '承認', reasonRequired: false },
          { gate: 'verify', kind: '否決', label: '否決して差し戻す', reasonRequired: true },
          { gate: 'plan', kind: '否決', label: '計画から立て直させる', reasonRequired: true },
          { gate: 'verify', kind: '中止', label: '中止する', reasonRequired: false },
        ],
      },
    ]);
    expect(report.working).toEqual([]);
  });

  it('計画レビューのカードには、画面と同じ判断（承認 / 否決して差し戻す / 中止）を出す', async () => {
    await writeCard('reviewing', "startedAt: '2026-10-21T00:00:00.000Z'\n", review('提出'));
    await writePlan('reviewing', '# 計画');

    const report = await runJson();

    expect(report.waiting[0]?.decisions.map((d) => `${d.gate} ${d.label}`)).toEqual([
      'plan 承認',
      'plan 否決して差し戻す',
      'plan 中止する',
    ]);
  });

  it('アイデアの表の並びを、区切り線を 1 行として画面と同じ順に出す', async () => {
    await writeCard('first', 'rank: 100\n');
    await writeCard('third', 'rank: 300\n');
    await writeCard('second', 'rank: 200\n');
    await writeCard('started', "startedAt: '2026-10-22T00:00:00.000Z'\nrank: 50\n");
    await createCardDependencies(db).ideaDividerRepository.set(250);

    const report = await runJson();

    expect(report.ideas).toEqual([
      { id: 'first', title: 'first のタイトル' },
      { id: 'second', title: 'second のタイトル' },
      { divider: true },
      { id: 'third', title: 'third のタイトル' },
    ]);
  });

  it('区切り線が未設定なら末尾に置く', async () => {
    await writeCard('only', '');

    const report = await runJson();

    expect(report.ideas).toEqual([{ id: 'only', title: 'only のタイトル' }, { divider: true }]);
  });

  it('起動中のサーバの URL を出す。見つからなければ null', async () => {
    expect((await runJson()).server).toBeNull();

    stdout = '';
    expect(await run(['--json'], stubProvider(), () => ({ url: 'http://127.0.0.1:5674' }))).toBe(0);
    expect((JSON.parse(stdout) as StatusReport).server).toEqual({ url: 'http://127.0.0.1:5674' });
  });

  it('GitHub が使えないときは接続状態に理由を載せ、次の一手を出さない', async () => {
    await writeCard('started', "startedAt: '2026-10-22T00:00:00.000Z'\n");

    const report = await runJson(
      stubProvider({ status: 'disabled', kind: 'github', reason: 'gh にログインしていません' })
    );

    expect(report.forge).toEqual({
      status: 'disabled',
      kind: 'github',
      reason: 'gh にログインしていません',
    });
    expect(report.next).toBeNull();
  });

  it('問い合わせが失敗したときも、github: が無いときも次の一手を出さない', async () => {
    await writeCard('started', "startedAt: '2026-10-22T00:00:00.000Z'\n");

    const failed = await runJson(
      stubProvider({ status: 'error', kind: 'github', message: 'HTTP 502' })
    );
    expect(failed.next).toBeNull();

    stdout = '';
    const unconfigured = await runJson(
      stubProvider({ status: 'disabled', kind: null, reason: null })
    );
    expect(unconfigured.next).toBeNull();
  });

  it('AI 作業中には、提出済みで成果物の見えないカードを含めない', async () => {
    await writeCard('lost', "startedAt: '2026-10-22T00:00:00.000Z'\n", review('提出'));
    await writeCard('started', "startedAt: '2026-10-22T00:00:00.000Z'\n");

    const report = await runJson();

    expect(report.working).toEqual([
      {
        id: 'started',
        title: 'started のタイトル',
        stage: 'planning',
        reason: expect.any(String),
        stale: false,
      },
    ]);
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
    expect(stdout).toContain('サーバ: 起動していません');
    expect(stdout).toContain('判断待ち (1)');
    expect(stdout).toContain('reviewing  [計画レビュー]  reviewing のタイトル');
    expect(stdout).toContain('AI 作業中 (1)');
    // 計画ファイルが無いので着手の時刻から数え、3 日以上たっている
    expect(stdout).toContain('impl  [実装中]  impl のタイトル  ※ 動きなし');
    expect(stdout).toContain('次の一手: implement impl（計画が承認されている）');
  });

  it('進められるカードが無ければ、次の一手は なし', async () => {
    expect(await run([])).toBe(0);

    expect(stdout).toContain('次の一手: なし（AI が進められるカードはありません）');
  });

  it('GitHub につながっていなければ、ループが止まることを出す', async () => {
    expect(await run([], stubProvider({ status: 'disabled', kind: null, reason: null }))).toBe(0);

    expect(stdout).toContain('GitHub: 未設定');
    expect(stdout).toContain('次の一手: なし（GitHub に接続できないため、ループは止まります）');
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

describe('parseStatusArgs', () => {
  it('--json の有無、--help、不明な引数を見分ける', () => {
    expect(parseStatusArgs([])).toEqual({ json: false });
    expect(parseStatusArgs(['--json'])).toEqual({ json: true });
    expect(parseStatusArgs(['--json', '--help'])).toBe('help');
    expect(parseStatusArgs(['-h'])).toBe('help');
    expect(parseStatusArgs(['--jsno'])).toBe('invalid');
  });
});
