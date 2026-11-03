import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createCliRunner } from '../../../infrastructure/cli-runner.js';
import { createDataStore, DATA_BRANCH } from '../../../infrastructure/data-store.js';
import { createFileCardDependencies, type CardDependencies } from '../../composition.js';
import {
  parseCommandArgs,
  runCardCli,
  type CardCliDependencies,
  type CardCliIo,
} from '../card-cli.js';
import type { CardId } from '../../../shared/schemas/common.js';
import { isErr, ok, type Result } from '../../../shared/result.js';
import type { ReviewGate } from '../../models/review.js';
import { REVIEW_HEADING, gateStates, parseReviewLog } from '../../services/review-log.js';
import { demoteHeadings } from '../../repositories/card-files.js';

// ============================================================
// 一時ディレクトリの bare リポジトリを origin にした clone で、本物の git を通して確かめる
// ============================================================

let tmp: string;
let origin: string;
let deps: CardCliDependencies;
let stdout: string;
let stderr: string;

const runner = createCliRunner({ timeoutMs: 30_000 });

// 書き込みのたびに本物の git で fetch・commit・push が走るので、既定の 5 秒では足りないことがある
vi.setConfig({ testTimeout: 30_000 });

const NOW = new Date('2026-09-26T00:00:00.000Z');

function sh(args: readonly string[]): string {
  return execFileSync('git', [...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function git(cwd: string, ...args: string[]): string {
  return sh(['-C', cwd, ...args]).trim();
}

/** clone ごとに親を分ける。ロックはデータのワークツリーの親に置かれ、同じ親だと push の拒否の道を通らない */
function cloneData(parent: string): string {
  fs.mkdirSync(parent, { recursive: true });
  const dir = path.join(parent, 'data');
  sh(['clone', '--quiet', '--branch', DATA_BRANCH, origin, dir]);
  return dir;
}

function cliDeps(dataDir: string): CardCliDependencies {
  return {
    store: createDataStore({ dataDir, runner, lockPollMs: 10 }),
    cards: createFileCardDependencies(dataDir),
  };
}

function originLog(): string[] {
  return git(origin, 'log', '--format=%s', DATA_BRANCH).split('\n');
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-card-cli-'));

  // 利用者の git の設定（署名など）に左右されないよう、空の設定と名前を与える
  const globalConfig = path.join(tmp, 'gitconfig');
  fs.writeFileSync(globalConfig, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_AUTHOR_NAME', 'ai-board');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'ai-board@example.com');
  vi.stubEnv('GIT_COMMITTER_NAME', 'ai-board');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'ai-board@example.com');

  origin = path.join(tmp, 'origin.git');
  sh(['init', '--quiet', '--bare', origin]);

  const seedDir = path.join(tmp, 'seed');
  sh(['clone', '--quiet', origin, seedDir]);
  git(seedDir, 'checkout', '--quiet', '--orphan', DATA_BRANCH);
  fs.writeFileSync(path.join(seedDir, 'ai-board-data.yaml'), 'version: 1\n');
  git(seedDir, 'add', '-A');
  git(seedDir, 'commit', '--quiet', '-m', 'data: 始める');
  git(seedDir, 'push', '--quiet', 'origin', `HEAD:refs/heads/${DATA_BRANCH}`);

  deps = cliDeps(cloneData(path.join(tmp, 'a')));
  stdout = '';
  stderr = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function io(stdin: string | null = null, now: Date = NOW): CardCliIo {
  return {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    readStdin: () => Promise.resolve(stdin),
    now: () => now,
  };
}

async function run(argv: readonly string[], stdin: string | null = null): Promise<number> {
  return runCardCli(argv, deps, io(stdin));
}

/** 準備の書き込みも、CLI と同じく transact を通して origin へ push する（直に書くと取り直しで消える） */
async function prepare(
  op: (cards: CardDependencies) => Promise<Result<unknown, unknown>>
): Promise<void> {
  const result = await deps.store.transact('data: テストの準備', () => op(deps.cards));
  if (isErr(result)) throw new Error(`準備に失敗しました: ${JSON.stringify(result.error)}`);
}

/**
 * カードを作る。本文の `## レビュー` の判断は、元の時刻のまま 1 件ずつ追記する
 * （新しいカードの本文に判断があると、ファイルのリポジトリは書かずに拒む）。
 */
async function seed(id: string, body = ''): Promise<void> {
  const index = body.indexOf(REVIEW_HEADING);
  const prose = index === -1 ? body : body.slice(0, index).replace(/\n+$/, '');

  await prepare(async (cards) => {
    const created = await cards.createCardCommand({ title: id, id, body: prose, createdAt: NOW });
    if (isErr(created)) return created;

    for (const entry of parseReviewLog(body)) {
      const appended = await cards.appendReviewCommand({
        id: id as CardId,
        gate: entry.gate,
        kind: entry.kind,
        reason: entry.reason,
        at: new Date(entry.at),
      });
      if (isErr(appended)) return appended;
    }
    return ok(undefined);
  });
}

/** 人の着手を打つ。plan の提出は着手したカードにしか書けない */
async function start(id: string): Promise<void> {
  await prepare((cards) =>
    cards.updateCardMetaCommand({
      id: id as CardId,
      patch: { startedAt: '2026-09-25T00:00:00.000Z' },
    })
  );
}

async function skip(id: string, skipGates: readonly ReviewGate[]): Promise<void> {
  await prepare((cards) =>
    cards.updateCardMetaCommand({ id: id as CardId, patch: { skipGates: [...skipGates] } })
  );
}

async function bodyOf(id: string): Promise<string | undefined> {
  return (await deps.cards.cardRepository.findById(id as CardId))?.body;
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

    const card = await deps.cards.cardRepository.findById('audit-log' as CardId);
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

    // 判断は log/ から組み立て直すので、本文の差し替えと判断を分けて確かめる
    const body = (await bodyOf('a')) ?? '';
    expect(body).toMatch(/^## 探索メモ\n新しい\n\n## レビュー\n/);
    expect(parseReviewLog(body)).toEqual(parseReviewLog(next));
    expect(originLog()[0]).toBe('data: a の本文を差し替える');
  });

  it('body はレビューログを書き換える差し替えを拒否する', async () => {
    const original = '## レビュー\n\n### 2026-09-20T00:00:00.000Z plan 提出\n';
    await seed('a', original);
    const before = await bodyOf('a');

    const forged = `${original}\n### 2026-09-21T00:00:00.000Z plan 承認\n`;
    expect(await run(['body', 'a'], forged)).toBe(1);
    expect(await run(['body', 'a'], '## 探索メモ\nレビューを消す\n\n## レビュー\n')).toBe(1);
    expect(await bodyOf('a')).toBe(before);
  });

  it('body は節の無い本文を、判断を変えずに本文だけ差し替える', async () => {
    const review = '## レビュー\n\n### 2026-09-20T00:00:00.000Z plan 提出\n';
    await seed('a', `## 探索メモ\n古い\n\n${review}`);

    expect(await run(['body', 'a'], '## 探索メモ\n新しい\n')).toBe(0);

    const body = (await bodyOf('a')) ?? '';
    expect(body).toMatch(/^## 探索メモ\n新しい\n\n## レビュー\n/);
    expect(parseReviewLog(body)).toEqual(parseReviewLog(review));
    expect(originLog()[0]).toBe('data: a の本文を差し替える');
  });

  it('body は標準入力が無いか、カードが無ければ 1', async () => {
    await seed('a');
    expect(await run(['body', 'a'])).toBe(1);
    expect(await run(['body', 'missing'], 'x')).toBe(1);
  });

  it('branch はブランチを紐付け、--clear で外す', async () => {
    await seed('a');

    expect(await run(['branch', 'a', 'feat/a'])).toBe(0);
    expect((await deps.cards.cardRepository.findById('a' as CardId))?.branch).toBe('feat/a');

    expect(await run(['branch', 'a', '--clear'])).toBe(0);
    expect((await deps.cards.cardRepository.findById('a' as CardId))?.branch).toBeNull();
  });

  it('branch は名前と --clear のどちらか一方でなければ 1', async () => {
    await seed('a');
    expect(await run(['branch', 'a'])).toBe(1);
    expect(await run(['branch', 'a', 'feat/a', '--clear'])).toBe(1);
    expect(await run(['branch', 'missing', 'feat/a'])).toBe(1);
  });

  it('submit は plan 提出を、否決の後の --resubmit で再提出を追記する', async () => {
    await seed('a');
    await start('a');

    expect(await run(['submit', 'a'])).toBe(0);
    expect(await bodyOf('a')).toContain('### 2026-09-26T00:00:00.000Z plan 提出');

    await seed(
      'b',
      '## レビュー\n\n### 2026-09-25T00:00:00.000Z plan 提出\n\n### 2026-09-25T01:00:00.000Z plan 否決\n\n直して'
    );
    await start('b');

    expect(await run(['submit', 'b', '--resubmit', '--reason', '指摘を反映'])).toBe(0);
    expect(await bodyOf('b')).toContain('### 2026-09-26T00:00:00.000Z plan 再提出\n\n指摘を反映');
  });

  it('submit は廃止した --gate verify を使い方とともに 1 にし、何も追記しない', async () => {
    await seed('a', '## レビュー\n\n### 2026-09-25T00:00:00.000Z plan 承認');
    await start('a');
    const original = await bodyOf('a');

    expect(await run(['submit', 'a', '--gate', 'verify', '--reason', '手順'])).toBe(1);
    expect(stderr).toContain('--gate には plan を');
    expect(stderr).toContain('使い方');
    expect(await bodyOf('a')).toBe(original);
  });

  it.each([
    ['提出済み', '### 2026-09-25T00:00:00.000Z plan 提出'],
    ['承認済み', '### 2026-09-25T00:00:00.000Z plan 承認'],
    [
      '保留',
      '### 2026-09-25T00:00:00.000Z plan 否決\n\n### 2026-09-25T01:00:00.000Z plan 保留\n\n止まる',
    ],
  ])(
    'submit は plan ゲートが%sのカードへの plan の提出と再提出を 1 にし、何も追記しない',
    async (_, log) => {
      await seed('a', `## レビュー\n\n${log}`);
      await start('a');
      const original = await bodyOf('a');

      expect(await run(['submit', 'a'])).toBe(1);
      expect(stderr).toContain('未提出か否決のとき');
      expect(await run(['submit', 'a', '--resubmit', '--reason', 'x'])).toBe(1);
      expect(await bodyOf('a')).toBe(original);
    }
  );

  it('submit は plan を飛ばすカードで、提出済み（承認と読まれる）の plan の再提出を 1 にする', async () => {
    await seed('a', '## レビュー\n\n### 2026-09-25T00:00:00.000Z plan 提出');
    await start('a');
    await skip('a', ['plan']);
    const before = await bodyOf('a');

    expect(await run(['submit', 'a', '--resubmit'])).toBe(1);
    expect(await bodyOf('a')).toBe(before);
  });

  it('submit は着手していないカードへの plan の提出と再提出を 1 にし、何も追記しない', async () => {
    const original = '## アイデア\nメモ';
    await seed('a', original);

    expect(await run(['submit', 'a'])).toBe(1);
    expect(stderr).toContain('着手したカード');
    expect(await run(['submit', 'a', '--gate', 'plan', '--resubmit', '--reason', 'x'])).toBe(1);
    expect(await bodyOf('a')).toBe(original);

    await start('a');
    expect(await run(['submit', 'a'])).toBe(0);
    expect(await bodyOf('a')).toContain('plan 提出');
  });

  it('submit は plan を飛ばす宣言があっても、着手していないカードへの plan の提出を 1 にする', async () => {
    await seed('a');
    await skip('a', ['plan']);

    expect(await run(['submit', 'a'])).toBe(1);
    expect(await run(['submit', 'a', '--resubmit'])).toBe(1);
    expect(await bodyOf('a')).toBe('');
  });

  it('submit は規定外の --gate を使い方とともに 1 にし、何も追記しない', async () => {
    await seed('a');

    expect(await run(['submit', 'a', '--gate', 'pr'])).toBe(1);
    expect(stderr).toContain('--gate には plan を');
    expect(stderr).toContain('使い方');
    expect(await run(['submit', 'a', '--gate'])).toBe(1);
    expect(await bodyOf('a')).toBe('');
  });

  it('submit は存在しないカードを 1 にする', async () => {
    expect(await run(['submit', 'missing'])).toBe(1);
    expect(stderr).toContain('見つかりません');
  });

  it('hold は理由付きの保留を追記し、ゲートを held にする', async () => {
    await seed(
      'a',
      '## レビュー\n\n### 2026-09-25T00:00:00.000Z plan 提出\n\n### 2026-09-25T01:00:00.000Z plan 否決\n\n範囲が広い'
    );

    expect(await run(['hold', 'a', '--gate', 'plan', '--reason', ' 直すには大きすぎる '])).toBe(0);
    expect(stdout.trim()).toBe('a');

    const body = (await bodyOf('a')) ?? '';
    expect(body).toContain('### 2026-09-26T00:00:00.000Z plan 保留\n\n直すには大きすぎる');
    expect(gateStates(parseReviewLog(body), []).plan).toBe('held');
  });

  it('hold は plan の保留を plan の承認前でも追記する', async () => {
    await seed('a', '## レビュー\n\n### 2026-09-25T00:00:00.000Z plan 否決\n\n範囲が広い');

    expect(await run(['hold', 'a', '--gate', 'plan', '--reason', '論点を決めてほしい'])).toBe(0);
    expect(gateStates(parseReviewLog((await bodyOf('a')) ?? ''), []).plan).toBe('held');
  });

  it('hold は --gate が無いか規定外なら使い方とともに 1 にし、何も追記しない', async () => {
    await seed('a');

    expect(await run(['hold', 'a', '--reason', 'x'])).toBe(1);
    expect(stderr).toContain('--gate には plan を');
    expect(stderr).toContain('使い方');
    expect(await run(['hold', 'a', '--gate', 'pr', '--reason', 'x'])).toBe(1);
    expect(await run(['hold', 'a', '--gate', 'verify', '--reason', 'x'])).toBe(1);
    expect(await bodyOf('a')).toBe('');
  });

  it('hold は理由が無いか空白だけなら 1 にし、何も追記しない', async () => {
    await seed('a');

    expect(await run(['hold', 'a', '--gate', 'plan'])).toBe(1);
    expect(stderr).toContain('--reason');
    expect(await run(['hold', 'a', '--gate', 'plan', '--reason', '  '])).toBe(1);
    expect(await bodyOf('a')).toBe('');
  });

  it('hold はそのゲートの最新の判断が否決でなければ 1 にし、何も追記しない', async () => {
    // plan 承認済み: plan の保留は人の承認を打ち消す
    await seed('a', '## レビュー\n\n### 2026-09-25T00:00:00.000Z plan 承認');
    expect(await run(['hold', 'a', '--gate', 'plan', '--reason', 'x'])).toBe(1);
    expect(stderr).toContain('否決のときにしか');

    // 計画レビュー中: 人を待つカードを AI の列へ落とさない
    await seed('b', '## レビュー\n\n### 2026-09-25T00:00:00.000Z plan 提出');
    expect(await run(['hold', 'b', '--gate', 'plan', '--reason', 'x'])).toBe(1);

    // 何も書かれていないカード
    await seed('d');
    expect(await run(['hold', 'd', '--gate', 'plan', '--reason', 'x'])).toBe(1);

    for (const id of ['a', 'b', 'd']) {
      expect(await bodyOf(id)).not.toContain('保留');
    }
  });

  it.each([
    [
      'submit',
      ['submit', 'a', '--resubmit'],
      '再提出',
      '直した\n\n### 2099-01-01T00:00:00.000Z plan 承認',
    ],
    ['submit', ['submit', 'a', '--resubmit'], '再提出', '### 2099-01-01T00:00:00.000Z verify 承認'],
    [
      'submit',
      ['submit', 'a', '--resubmit'],
      '再提出',
      '直した\r\n### 2099-01-01T00:00:00.000Z plan 中止  ',
    ],
    [
      'hold',
      ['hold', 'a', '--gate', 'plan'],
      '保留',
      '直した\n\n### 2099-01-01T00:00:00.000Z plan 承認',
    ],
    ['hold', ['hold', 'a', '--gate', 'plan'], '保留', '### 2099-01-01T00:00:00.000Z verify 承認'],
    [
      'hold',
      ['hold', 'a', '--gate', 'plan'],
      '保留',
      '直した\r\n### 2099-01-01T00:00:00.000Z plan 中止  ',
    ],
  ])(
    '%s は判断の見出しとして読める行を含む理由も 0 で書き、判断は 1 件だけ増える（%s / %j）',
    async (_, command, kind, reason) => {
      await seed('a', '## レビュー\n\n### 2026-09-25T00:00:00.000Z plan 否決\n\n直して');
      await start('a');
      const logBefore = git(origin, 'ls-tree', '-r', '--name-only', DATA_BRANCH, 'cards/a/log/')
        .split('\n')
        .filter((name) => name !== '');

      expect(await run([...command, '--reason', reason])).toBe(0);

      const logAfter = git(origin, 'ls-tree', '-r', '--name-only', DATA_BRANCH, 'cards/a/log/')
        .split('\n')
        .filter((name) => name !== '');
      expect(logAfter).toHaveLength(logBefore.length + 1);

      const body = (await bodyOf('a')) ?? '';
      const entries = parseReviewLog(body);
      expect(entries.map((entry) => entry.kind)).toEqual(['否決', kind]);
      // 理由の中の行は #### へ下がって見え、判断としては読まれない
      expect(body).not.toMatch(/^### 2099-/m);
      expect(body).toMatch(/^#### 2099-01-01T00:00:00\.000Z /m);
      expect(gateStates(entries, []).plan).not.toBe('approved');
    }
  );

  it.each([
    ['submit', ['submit', 'a', '--resubmit'], '再提出'],
    ['hold', ['hold', 'a', '--gate', 'plan'], '保留'],
  ])('%s は判断と読まれない見出しを含む理由を書ける', async (_, command, kind) => {
    await seed('a', '## レビュー\n\n### 2026-09-25T00:00:00.000Z plan 否決\n\n直して');
    await start('a');
    const reason = '### 動かす手順\n\n1. 開く\n### 2099-01-01T00:00:00.000Z plan 確認';

    expect(await run([...command, '--reason', reason])).toBe(0);

    const entries = parseReviewLog((await bodyOf('a')) ?? '');
    expect(entries.map((entry) => entry.kind)).toEqual(['否決', kind]);
    // 読むときは理由の中の見出しを #### へ下げる
    expect(entries.at(-1)?.reason).toBe(demoteHeadings(reason));
  });

  it('hold は存在しないカードや不正な ID を 1 にする', async () => {
    expect(await run(['hold', 'missing', '--gate', 'plan', '--reason', 'x'])).toBe(1);
    expect(stderr).toContain('見つかりません');
    expect(await run(['hold', 'Bad Id', '--gate', 'plan', '--reason', 'x'])).toBe(1);
  });
});

describe('runCardCli とデータ用ブランチ', () => {
  it('書き込みは 1 コマンド 1 コミットで origin へ push し、メッセージに理由やブランチ名を入れない', async () => {
    await seed('a');
    await start('a');

    expect(await run(['branch', 'a', 'feat/secret-name'])).toBe(0);
    expect(await run(['submit', 'a', '--reason', '秘密の理由'])).toBe(0);

    expect(originLog().slice(0, 2)).toEqual([
      'data: a に plan 提出 を足す',
      'data: a にブランチを紐付ける',
    ]);
    expect(originLog().join('\n')).not.toMatch(/secret-name|秘密の理由/);
  });

  it('create は作ったカードの ID でコミットする', async () => {
    expect(await run(['create', '--title', 'Audit Log'])).toBe(0);
    expect(originLog()[0]).toBe('data: audit-log を作る');
  });

  it('検査で拒んだ書き込みはコミットしない', async () => {
    await seed('a');
    const before = originLog();

    expect(await run(['submit', 'a'])).toBe(1);
    expect(await run(['hold', 'a', '--gate', 'plan', '--reason', 'x'])).toBe(1);
    expect(await run(['branch', 'missing', 'feat/x'])).toBe(1);

    expect(originLog()).toEqual(before);
  });

  it('読むコマンドは、ほかの clone が push した最新のカードを読む', async () => {
    const other = cliDeps(cloneData(path.join(tmp, 'b')));
    expect(await runCardCli(['create', '--title', 'x', '--id', 'from-b'], other, io())).toBe(0);

    stdout = '';
    expect(await run(['show', 'from-b'])).toBe(0);
    expect(stdout).toContain('id: from-b');
  });

  it('書くコマンドは、ほかの clone が push した最新のカードに対して検査する', async () => {
    await seed('a');
    await start('a');

    const other = cliDeps(cloneData(path.join(tmp, 'b')));
    expect(await runCardCli(['submit', 'a'], other, io())).toBe(0);

    // 手元の clone はまだ未提出の状態だが、取り直してから検査するので拒む
    expect(await run(['submit', 'a'])).toBe(1);
    expect(stderr).toContain('未提出か否決のとき');
  });

  it('2 つの clone から同じカードに同時に submit すると、1 つだけが通る（ルーティンの重複起動）', async () => {
    await seed('a');
    await start('a');

    const other = cliDeps(cloneData(path.join(tmp, 'b')));
    let otherStderr = '';
    const otherIo: CardCliIo = {
      ...io(null, new Date(NOW.getTime() + 1000)),
      stderr: (text) => {
        otherStderr += text;
      },
    };

    const codes = await Promise.all([
      run(['submit', 'a']),
      runCardCli(['submit', 'a'], other, otherIo),
    ]);

    expect([...codes].sort()).toEqual([0, 1]);
    expect(`${stderr}${otherStderr}`).toContain('未提出か否決のとき');
    expect(originLog().filter((message) => message === 'data: a に plan 提出 を足す')).toHaveLength(
      1
    );
    const logFiles = git(origin, 'ls-tree', '-r', '--name-only', DATA_BRANCH, 'cards/a/log/');
    expect(logFiles.split('\n').filter((name) => name.endsWith('.plan.submit.md'))).toHaveLength(1);
  });

  it('fetch できなければ、読むコマンドは警告して手元の内容で読み、書くコマンドは失敗する', async () => {
    await seed('a');
    fs.renameSync(origin, `${origin}.offline`);

    expect(await run(['show', 'a'])).toBe(0);
    expect(stdout).toContain('id: a');
    expect(stderr).toContain('手元の内容で読みます');

    stderr = '';
    expect(await run(['branch', 'a', 'feat/a'])).toBe(1);
    expect(stderr).toContain('書き込めません');
    expect((await deps.cards.cardRepository.findById('a' as CardId))?.branch).toBeNull();
  });

  it('データ用ブランチが無ければ、init を案内する', async () => {
    deps = cliDeps(path.join(tmp, 'none', 'data'));

    expect(await run(['list'])).toBe(1);
    expect(stderr).toContain('データ用ブランチ');
    expect(stderr).toContain('ai-board init を走らせてください');
    expect(stderr).not.toContain('migrate');

    stderr = '';
    expect(await run(['create', '--title', 'x'])).toBe(1);
    expect(stderr).toContain('ai-board init を走らせてください');
  });

  it('origin にデータ用ブランチの無いリポジトリでも init を案内する', async () => {
    const bare = path.join(tmp, 'code.git');
    sh(['init', '--quiet', '--bare', bare]);
    const repo = path.join(tmp, 'code');
    sh(['clone', '--quiet', bare, repo]);

    const dataDir = path.join(repo, '.ai-board', 'data');
    deps = {
      store: createDataStore({ dataDir, repoRoot: repo, runner, lockPollMs: 10 }),
      cards: createFileCardDependencies(dataDir),
    };

    expect(await run(['list'])).toBe(1);
    expect(stderr).toContain('ai-board init を走らせてください');
  });

  it('人がデータのワークツリーを消しても、次のコマンドが作り直して読み書きできる', async () => {
    const repo = path.join(tmp, 'code');
    sh(['clone', '--quiet', origin, repo]);
    const dataDir = path.join(repo, '.ai-board', 'data');
    deps = {
      store: createDataStore({ dataDir, repoRoot: repo, runner, lockPollMs: 10 }),
      cards: createFileCardDependencies(dataDir),
    };
    expect(await run(['create', '--title', 'x', '--id', 'before'])).toBe(0);

    fs.rmSync(dataDir, { recursive: true, force: true });

    stdout = '';
    expect(await run(['show', 'before'])).toBe(0);
    expect(stdout).toContain('id: before');
    expect(await run(['create', '--title', 'y', '--id', 'after'])).toBe(0);
    expect(originLog()[0]).toBe('data: after を作る');
    expect(stderr).toBe('');
  });

  it('origin のデータの形の版がこの CLI より新しければ、list も submit も読まずに 1 にし、何も書かない', async () => {
    await seed('a');
    await start('a');

    // 新しい ai-board が、形の版を上げて push した
    const newer = cloneData(path.join(tmp, 'newer'));
    fs.writeFileSync(path.join(newer, 'ai-board-data.yaml'), 'version: 2\n');
    git(newer, 'commit', '--quiet', '-am', 'data: 形の版を 2 に上げる');
    git(newer, 'push', '--quiet', 'origin', `HEAD:refs/heads/${DATA_BRANCH}`);
    const before = originLog();

    expect(await run(['list'])).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toContain('形の版（2）');
    expect(stderr).toContain('ai-board を新しくして');

    stderr = '';
    expect(await run(['submit', 'a'])).toBe(1);
    expect(stderr).toContain('形の版（2）');
    expect(originLog()).toEqual(before);
    expect(
      git(origin, 'ls-tree', '-r', '--name-only', DATA_BRANCH, 'cards/a/log/')
        .split('\n')
        .filter((name) => name.endsWith('.plan.submit.md'))
    ).toHaveLength(0);
  });

  it('引数の誤りでは、データ用ブランチに触らない', async () => {
    deps = cliDeps(path.join(tmp, 'none', 'data'));

    expect(await run(['show'])).toBe(1);
    expect(await run(['submit', 'a', '--gate', 'pr'])).toBe(1);
    expect(stderr).not.toContain('データ用ブランチ');
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
