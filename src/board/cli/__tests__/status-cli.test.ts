import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFileCardDependencies } from '../../../cards/composition.js';
import { parseCard } from '../../../cards/repositories/card-markdown.js';
import { REVIEW_HEADING, parseReviewLog } from '../../../cards/services/review-log.js';
import { isErr } from '../../../shared/result.js';
import { createBoardDependencies, createLoopHistoryRepository } from '../../composition.js';
import { writeLoopFinish, writeLoopStart } from '../../repositories/loop-history.repository.js';
import type { MrStateProvider } from '../../services/mr-state-provider.js';
import type { ForgeConnection, MrState } from '../../models/mr-state.js';
import type { MergeRequestIid } from '../../../shared/schemas/common.js';
import { HOLD_REASONS } from '../../services/next-action.js';
import {
  emptyBranchPlanRepository,
  type BranchPlanRepository,
} from '../../repositories/branch-plan.repository.js';
import type { ImplStepPlan } from '../../services/impl-step.js';
import { parseStatusArgs, pickFields, runStatusCli } from '../status-cli.js';
import type { StatusReport } from '../../models/status-report.js';
import { createGetStatusQuery } from '../../usecases/queries/get-status.query.js';

// ============================================================
// テスト用プロジェクトの組み立て
// ============================================================

let root: string;
/** データのワークツリーの代わりのディレクトリ。git は使わず、ファイルのリポジトリで直に読み書きする */
let dataDir: string;
let stdout: string;
let stderr: string;

const NOW = new Date('2026-10-23T00:00:00.000Z');

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-status-'));
  dataDir = path.join(root, 'data');
  stdout = '';
  stderr = '';
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

async function writeCard(id: string, frontmatter: string, body = ''): Promise<void> {
  const card = parseCard(
    `${id}.md`,
    `---\nid: ${id}\ntitle: ${id} のタイトル\n${frontmatter}---\n${body}`
  );
  if (card === null) throw new Error(`テスト用のカードが読めません: ${id}`);

  // 新しいカードの本文に判断があると、ファイルのリポジトリは書かずに拒む。判断は元の時刻のまま 1 件ずつ足す
  const cards = createFileCardDependencies(dataDir);
  const index = card.body.indexOf(REVIEW_HEADING);
  const prose = index === -1 ? card.body : card.body.slice(0, index).replace(/\n+$/, '');
  if (!(await cards.cardRepository.create({ ...card, body: prose }))) {
    throw new Error(`テスト用のカードを作れません: ${id}`);
  }

  for (const entry of parseReviewLog(card.body)) {
    const appended = await cards.appendReviewCommand({
      ...entry,
      id: card.id,
      at: new Date(entry.at),
    });
    if (isErr(appended)) throw new Error(`判断を足せません: ${JSON.stringify(appended.error)}`);
  }
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
  return {
    get: () => null,
    connection: () => connection,
    synced: () => true,
    failure: () => null,
  };
}

async function run(
  argv: readonly string[],
  provider = stubProvider(),
  branchPlanRepository?: BranchPlanRepository
): Promise<number> {
  const cards = createFileCardDependencies(dataDir);
  const board = createBoardDependencies(
    path.join(root, '.ai-board', 'plans'),
    cards.cardRepository,
    cards.ideaDividerRepository,
    provider,
    createLoopHistoryRepository(dataDir)
  );

  return runStatusCli(
    argv,
    { getStatusQuery: createGetStatusQuery(board.getBoardQuery, branchPlanRepository) },
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
      step: null,
    });
    expect(report.waiting.map((card) => [card.id, card.stage])).toEqual([
      ['reviewing', 'plan-review'],
    ]);
    expect(report.cards.map((card) => card.id).sort()).toEqual(['idea', 'reviewing', 'started']);
    expect(report.forge).toEqual({ status: 'connected', kind: 'github' });
  });

  it('PR中 で人の指摘に AI が応える番のカードは、next の fix-pr になり、waiting でなく working の先頭に出る', async () => {
    await writeCard('impling', "startedAt: '2026-10-21T00:00:00.000Z'\n", review('承認'));
    await writeCard('fixing', "startedAt: '2026-10-19T00:00:00.000Z'\nmr: 12\n", review('承認'));
    await writeCard(
      'waiting-pr',
      "startedAt: '2026-10-19T00:00:00.000Z'\nmr: 13\n",
      review('承認')
    );

    const pr = (iid: number, latestNoteAt: string | null): MrState => ({
      forge: 'github',
      iid: iid as MergeRequestIid,
      state: 'opened',
      draft: false,
      sourceBranch: `branch-${iid}`,
      title: `PR ${iid}`,
      webUrl: `https://github.com/acme/board/pull/${iid}`,
      latestNoteAt,
      noteCount: latestNoteAt === null ? 0 : 1,
      latestAiNoteAt: null,
      latestCommitAt: '2026-10-21T00:00:00.000Z',
      mergedAt: null,
      readyAt: '2026-10-21T00:00:00.000Z',
      convertedToDraftAt: null,
    });
    const states: Record<string, MrState> = {
      fixing: pr(12, '2026-10-22T00:00:00.000Z'),
      'waiting-pr': pr(13, null),
    };
    const provider: MrStateProvider = {
      get: (cardId) => states[cardId] ?? null,
      connection: () => ({ status: 'connected', kind: 'github' }),
      synced: () => true,
      failure: () => null,
    };

    const report = await runJson(provider);

    expect(report.next).toEqual({
      cardId: 'fixing',
      action: 'fix-pr',
      reason: 'PR に人の指摘があり、まだ応えていない',
      step: null,
    });
    expect(report.waiting.map((card) => card.id)).toEqual(['waiting-pr']);
    expect(report.working.map((card) => card.id)).toEqual(['fixing', 'impling']);
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
        phases: [],
      },
      {
        kind: 'planning',
        owner: 'ai',
        start: '2026-10-19T12:00:00.000Z',
        end: '2026-10-20T00:00:00.000Z',
        phases: [],
      },
      {
        kind: 'plan-review',
        owner: 'human',
        start: '2026-10-20T00:00:00.000Z',
        end: null,
        phases: [],
      },
    ]);
  });

  it('ループの 1 手の記録を、ループの様子・カードの手の一覧・AI の区間の待ちと作業に載せる', async () => {
    await writeCard(
      'reviewing',
      "created: '2026-10-19T00:00:00.000Z'\nstartedAt: '2026-10-19T12:00:00.000Z'\n",
      review('提出')
    );
    await writePlan('reviewing', '# 計画\n\n- [ ] 1');
    await writeCard('started', "startedAt: '2026-10-22T00:00:00.000Z'\n");
    writeLoopStart(dataDir, {
      loop: 'session-a',
      cardId: 'reviewing',
      action: 'plan',
      step: null,
      agent: 'board-planner',
      harness: null,
      startedAt: '2026-10-19T18:00:00.000Z',
    });
    writeLoopFinish(dataDir, {
      loop: 'session-a',
      cardId: 'reviewing',
      result: 'advanced',
      tokens: 100,
      durationMs: 3_600_000,
      finishedAt: '2026-10-19T19:00:00.000Z',
    });
    writeLoopStart(dataDir, {
      loop: 'session-a',
      cardId: 'started',
      action: 'plan',
      step: null,
      agent: null,
      harness: null,
      startedAt: '2026-10-22T23:30:00.000Z',
    });

    const report = await runJson();
    const reviewing = report.cards.find((card) => card.id === 'reviewing');

    expect(report.loop.running.map((step) => step.cardId)).toEqual(['started']);
    expect(report.loop.lastFinishedAt).toBe('2026-10-19T19:00:00.000Z');
    expect(reviewing?.loopSteps.map((step) => step.result)).toEqual(['advanced']);
    expect(reviewing?.timeline[1]?.phases).toEqual([
      { kind: 'wait', start: '2026-10-19T12:00:00.000Z', end: '2026-10-19T18:00:00.000Z' },
      { kind: 'work', start: '2026-10-19T18:00:00.000Z', end: '2026-10-19T19:00:00.000Z' },
      { kind: 'wait', start: '2026-10-19T19:00:00.000Z', end: '2026-10-20T00:00:00.000Z' },
    ]);
    expect(report.working.find((card) => card.id === 'started')?.running).toBe(true);
    expect(report.waiting.find((card) => card.id === 'reviewing')?.running).toBe(false);
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
        running: false,
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

  it('AI が保留を書いて止まったカードは、判断待ちに 1 度だけ出し、飛ばして後ろのカードを選ぶ', async () => {
    await writeCard(
      'held',
      "startedAt: '2026-10-20T00:00:00.000Z'\nrank: 1\n",
      `${review('提出')}\n### 2026-10-21T00:00:00.000Z plan 差し戻し\n\n範囲が広い\n\n### 2026-10-22T00:00:00.000Z plan 保留\n\n論点を決めてほしい\n`
    );
    await writeCard('started', "startedAt: '2026-10-22T00:00:00.000Z'\nrank: 2\n");

    const report = await runJson();

    expect(report.next).toEqual({
      cardId: 'started',
      action: 'plan',
      reason: '着手が指示され、計画がまだ無い',
      step: null,
    });
    expect(report.waiting).toEqual([
      {
        id: 'held',
        title: 'held のタイトル',
        stage: 'planning',
        reason: HOLD_REASONS.planHeld,
        running: false,
        decisions: [
          { gate: 'plan', kind: '差し戻し', label: '計画を直させる', reasonRequired: true },
          { gate: 'plan', kind: '中止', label: '中止する', reasonRequired: false },
        ],
      },
    ]);
    expect(report.working.map((card) => card.id)).toEqual(['started']);
    expect(report.cards.find((card) => card.id === 'held')?.hold).toEqual({
      kind: 'decision',
      reason: HOLD_REASONS.planHeld,
      since: '2026-10-22T00:00:00.000Z',
    });
  });

  it('1 枚の PR だけを引けないときは、そのカードを判断待ちに出し、出せる判断を出さずに後ろのカードを選ぶ', async () => {
    await writeCard('failing', "startedAt: '2026-10-20T00:00:00.000Z'\nrank: 1\nbranch: failing\n");
    await writeCard('started', "startedAt: '2026-10-22T00:00:00.000Z'\nrank: 2\n");
    const provider: MrStateProvider = {
      get: () => null,
      connection: () => ({ status: 'connected', kind: 'github' }),
      synced: () => true,
      failure: (cardId) =>
        cardId === 'failing'
          ? {
              message: 'ブランチ failing の PR の解決（pulls）が HTTP 422 で失敗した',
              since: '2026-10-23T00:00:00.000Z',
            }
          : null,
    };

    const report = await runJson(provider);

    expect(report.forge.status).toBe('connected');
    expect(report.next?.cardId).toBe('started');
    expect(report.waiting).toEqual([
      {
        id: 'failing',
        title: 'failing のタイトル',
        stage: 'planning',
        reason: HOLD_REASONS.forgeFailed(
          'ブランチ failing の PR の解決（pulls）が HTTP 422 で失敗した'
        ),
        running: false,
        decisions: [],
      },
    ]);
  });

  it('廃止した verify の提出が残る実装中のカードは、判断待ちに出さずに implement を選ぶ', async () => {
    await writeCard(
      'old-verify',
      "startedAt: '2026-10-21T00:00:00.000Z'\n",
      `${review('承認')}\n### 2026-10-22T00:00:00.000Z verify 提出\n`
    );

    const report = await runJson();

    expect(report.waiting).toEqual([]);
    expect(report.next).toMatchObject({ cardId: 'old-verify', action: 'implement' });
    expect(report.cards.find((card) => card.id === 'old-verify')?.stage).toBe('impling');
  });

  it('計画レビューのカードには、出せる判断（承認 / 差し戻す / 中止）を出す', async () => {
    await writeCard('reviewing', "startedAt: '2026-10-21T00:00:00.000Z'\n", review('提出'));
    await writePlan('reviewing', '# 計画');

    const report = await runJson();

    expect(report.waiting[0]?.decisions.map((d) => `${d.gate} ${d.label}`)).toEqual([
      'plan 承認',
      'plan 差し戻す',
      'plan 中止する',
    ]);
  });

  it('アイデアの表の並びを、区切り線を 1 行として ideaRows の順に出す', async () => {
    await writeCard('first', 'rank: 100\n');
    await writeCard('third', 'rank: 300\n');
    await writeCard('second', 'rank: 200\n');
    await writeCard('started', "startedAt: '2026-10-22T00:00:00.000Z'\nrank: 50\n");
    await createFileCardDependencies(dataDir).ideaDividerRepository.set(250);

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

  it('問い合わせが失敗したときは次の一手を出さず、github: が無い（未設定）ときは出す', async () => {
    await writeCard('started', "startedAt: '2026-10-22T00:00:00.000Z'\n");

    const failed = await runJson(
      stubProvider({ status: 'error', kind: 'github', message: 'HTTP 502' })
    );
    expect(failed.next).toBeNull();

    stdout = '';
    const unconfigured = await runJson(
      stubProvider({ status: 'disabled', kind: null, reason: null })
    );
    expect(unconfigured.next).toMatchObject({ cardId: 'started', action: 'plan' });
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
        running: false,
        stale: false,
      },
    ]);
  });
});

// ============================================================
// --json の next.step（implement の段）
// ============================================================

/** 読み手の偽物。呼ばれた引数を控え、決めた計画を返す */
function stubPlanReader(plan: ImplStepPlan | null): BranchPlanRepository & {
  readonly calls: Array<[string, string]>;
} {
  const calls: Array<[string, string]> = [];
  return {
    ...emptyBranchPlanRepository,
    calls,
    find: (cardId, branch) => {
      calls.push([cardId, branch]);
      return Promise.resolve(plan);
    },
  };
}

async function runJsonWith(reader: BranchPlanRepository): Promise<StatusReport> {
  expect(await run(['--json'], stubProvider(), reader)).toBe(0);
  return JSON.parse(stdout) as StatusReport;
}

const IMPLING = "startedAt: '2026-10-01T00:00:00.000Z'\nbranch: impl-branch\n";

describe('ai-board status --json の next.step', () => {
  it('implement の手では、カードのブランチの計画から段を載せる', async () => {
    await writeCard('impl', IMPLING, review('承認'));
    const reader = stubPlanReader({ location: 'active', text: '# 計画\n\n- [x] 1\n- [ ] 2\n' });

    const report = await runJsonWith(reader);

    expect(report.next).toMatchObject({ cardId: 'impl', action: 'implement', step: 'task' });
    expect(reader.calls).toEqual([['impl', 'impl-branch']]);
  });

  it('倒し終えて AI レビュー節が無ければ review、archive 済みなら close を載せる', async () => {
    await writeCard('impl', IMPLING, review('承認'));

    const toReview = await runJsonWith(stubPlanReader({ location: 'active', text: '- [x] 1\n' }));
    expect(toReview.next?.step).toBe('review');

    stdout = '';
    const closed = await runJsonWith(stubPlanReader({ location: 'archived' }));
    expect(closed.next?.step).toBe('close');
  });

  it('implement 以外の手では計画を読まず、step は null', async () => {
    await writeCard('started', "startedAt: '2026-10-22T00:00:00.000Z'\nbranch: started\n");
    const reader = stubPlanReader({ location: 'active', text: '- [ ] 1\n' });

    const report = await runJsonWith(reader);

    expect(report.next).toMatchObject({ cardId: 'started', action: 'plan', step: null });
    expect(reader.calls).toEqual([]);
  });

  it('計画を読めなければ step は null のまま、status は成功する', async () => {
    await writeCard('impl', IMPLING, review('承認'));

    const report = await runJsonWith(stubPlanReader(null));

    expect(report.next).toMatchObject({ cardId: 'impl', action: 'implement', step: null });
  });

  it('カードの branch が null なら、読み手を呼ばずに step は null', async () => {
    await writeCard('impl', "startedAt: '2026-10-01T00:00:00.000Z'\n", review('承認'));
    const reader = stubPlanReader({ location: 'active', text: '- [ ] 1\n' });

    const report = await runJsonWith(reader);

    expect(report.next).toMatchObject({ action: 'implement', step: null });
    expect(reader.calls).toEqual([]);
  });

  it('読み手を渡さなければ、implement でも step は null', async () => {
    await writeCard('impl', IMPLING, review('承認'));

    const report = await runJson();

    expect(report.next).toMatchObject({ action: 'implement', step: null });
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
    expect(stdout).not.toContain('サーバ:');
    expect(stdout).toContain('ループ: 記録なし');
    expect(stdout).toContain('判断待ち (1)');
    expect(stdout).toContain('reviewing  [計画レビュー]  reviewing のタイトル');
    expect(stdout).toContain('AI 作業中 (1)');
    // 計画ファイルが無いので着手の時刻から数え、3 日以上たっている
    expect(stdout).toContain('impl  [実装中]  impl のタイトル  ※ 動きなし');
    expect(stdout).toContain('次の一手: implement impl 段=不明（計画が承認されている）');
  });

  it('ループが今触っているカードと、その行の印を出す', async () => {
    await writeCard('impl', "startedAt: '2026-10-22T00:00:00.000Z'\n", review('承認'));
    writeLoopStart(dataDir, {
      loop: 'session-a',
      cardId: 'impl',
      action: 'implement',
      step: 'task',
      agent: null,
      harness: null,
      startedAt: '2026-10-22T23:48:00.000Z',
    });

    expect(await run([])).toBe(0);

    expect(stdout).toMatch(/ループ: impl のタイトル を implement（task） 中（[^）]+）/);
    expect(stdout).toContain('impl  [実装中]  impl のタイトル  ※ AI 稼働中');
  });

  it('次の一手のカードが同じ手で止まり続けていれば、回数を添える', async () => {
    await writeCard('impl', "startedAt: '2026-10-22T00:00:00.000Z'\n", review('承認'));
    for (const startedAt of ['2026-10-22T10:00:00.000Z', '2026-10-22T11:00:00.000Z']) {
      writeLoopStart(dataDir, {
        loop: 'session-a',
        cardId: 'impl',
        action: 'implement',
        step: null,
        agent: null,
        harness: 'v1',
        startedAt,
      });
      writeLoopFinish(dataDir, {
        loop: 'session-a',
        cardId: 'impl',
        result: 'stopped',
        tokens: null,
        durationMs: null,
        finishedAt: startedAt.replace(':00:00', ':30:00'),
      });
    }

    expect(await run([])).toBe(0);

    expect(stdout).toContain(
      '次の一手: implement impl 段=不明（計画が承認されている）  ※ 止まった ×2'
    );
  });

  it('implement の次の一手に、カードのブランチの計画から決めた段を出す', async () => {
    await writeCard('impl', IMPLING, review('承認'));
    const reader = stubPlanReader({ location: 'active', text: '- [x] 1\n' });

    expect(await run([], stubProvider(), reader)).toBe(0);

    expect(stdout).toContain('次の一手: implement impl 段=review（計画が承認されている）');
  });

  it('進められるカードが無ければ、次の一手は なし', async () => {
    expect(await run([])).toBe(0);

    expect(stdout).toContain('次の一手: なし（AI が進められるカードはありません）');
  });

  it('GitHub につながっていなければ、ループが止まることを出す', async () => {
    const unavailable = stubProvider({ status: 'disabled', kind: 'github', reason: 'gh が無い' });
    expect(await run([], unavailable)).toBe(0);

    expect(stdout).toContain('GitHub: 使えません（gh が無い）');
    expect(stdout).toContain('次の一手: なし（GitHub に接続できないため、ループは止まります）');
  });

  it('GitHub が未設定なら、ループが止まるとは出さない', async () => {
    expect(await run([], stubProvider({ status: 'disabled', kind: null, reason: null }))).toBe(0);

    expect(stdout).toContain('GitHub: 未設定');
    expect(stdout).toContain('次の一手: なし（AI が進められるカードはありません）');
  });
});

// ============================================================
// --only
// ============================================================

describe('ai-board status --json --only', () => {
  beforeEach(async () => {
    await writeCard('started', "startedAt: '2026-10-22T00:00:00.000Z'\n");
    await writeCard('reviewing', "startedAt: '2026-10-21T00:00:00.000Z'\n", review('提出'));
    await writePlan('reviewing', '# 計画\n\n- [ ] 1');
  });

  async function runOnly(only: string): Promise<Record<string, unknown>> {
    expect(await run(['--json', '--only', only])).toBe(0);
    return JSON.parse(stdout) as Record<string, unknown>;
  }

  it('最上位の項目だけを、指した順に出す', async () => {
    const report = await runOnly('waiting,next,forge');

    expect(Object.keys(report)).toEqual(['waiting', 'next', 'forge']);
    expect(report['next']).toMatchObject({ cardId: 'started', action: 'plan' });
    expect(report['forge']).toEqual({ status: 'connected', kind: 'github' });
  });

  it('配列の各要素から、指した項目だけを出す', async () => {
    const report = await runOnly('cards.id,cards.stage');

    expect(Object.keys(report)).toEqual(['cards']);
    expect(report['cards']).toEqual(
      expect.arrayContaining([
        { id: 'started', stage: 'planning' },
        { id: 'reviewing', stage: 'plan-review' },
      ])
    );
  });

  it('最上位の項目と、配列の要素の項目を混ぜられる', async () => {
    const report = await runOnly('forge,cards.id,next');

    expect(Object.keys(report)).toEqual(['forge', 'cards', 'next']);
    expect(report['forge']).toEqual({ status: 'connected', kind: 'github' });
    expect((report['cards'] as object[]).every((card) => Object.keys(card).join() === 'id')).toBe(
      true
    );
  });

  it.each([
    ['無い最上位の項目', ['--json', '--only', 'nosuch']],
    ['配列でない項目への .', ['--json', '--only', 'next.cardId']],
    ['2 段以上の .', ['--json', '--only', 'cards.mrState.webUrl']],
    ['空の項目', ['--json', '--only', 'cards.']],
    ['値が無い', ['--json', '--only']],
    ['形の指定が無い', ['--only', 'next']],
  ])('%s は使い方を出して 1 で終わる', async (_name, argv) => {
    expect(await run(argv)).toBe(1);
    expect(stderr).toContain('使い方: ai-board status');
    expect(stdout).toBe('');
  });
});

describe('pickFields', () => {
  const report = {
    next: null,
    ideas: [{ id: 'a', title: 'A' }, { divider: true }, { id: 'b', title: 'B' }],
  } as unknown as StatusReport;

  it('要素に無い項目は、その要素では出さない', () => {
    expect(pickFields(report, [{ key: 'ideas', field: 'id' }])).toEqual({
      ideas: [{ id: 'a' }, {}, { id: 'b' }],
    });
  });

  it('同じ項目を丸ごとと .<field> の両方で指したら、丸ごと出す', () => {
    expect(
      pickFields(report, [
        { key: 'ideas', field: 'id' },
        { key: 'ideas', field: null },
      ])
    ).toEqual({ ideas: report.ideas });
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

  it('消した server の項目を --only で指すと、使い方を出して 1 で終わる', async () => {
    expect(await run(['--json', '--only', 'server'])).toBe(1);
    expect(stdout).toBe('');
  });

  it('不明な引数は使い方を出して 1 で終わる', async () => {
    expect(await run(['--yaml'])).toBe(1);
    expect(stderr).toContain('使い方: ai-board status');
    expect(stdout).toBe('');
  });
});

describe('parseStatusArgs', () => {
  it('--json の有無、--help、不明な引数を見分ける', () => {
    expect(parseStatusArgs([])).toEqual({ format: 'text' });
    expect(parseStatusArgs(['--json'])).toEqual({ format: 'json' });
    expect(parseStatusArgs(['--html'])).toBe('invalid');
    expect(parseStatusArgs(['--json', '--help'])).toBe('help');
    expect(parseStatusArgs(['-h'])).toBe('help');
    expect(parseStatusArgs(['--jsno'])).toBe('invalid');
    expect(parseStatusArgs(['--json', '--only', 'next,cards.id'])).toEqual({
      format: 'json',
      only: [
        { key: 'next', field: null },
        { key: 'cards', field: 'id' },
      ],
    });
    expect(parseStatusArgs(['--json', '--only', 'next', '--only', 'forge'])).toBe('invalid');
  });
});
