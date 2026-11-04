import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createFileCardDependencies } from '../../../cards/composition.js';
import { parseCard } from '../../../cards/repositories/card-markdown.js';
import { REVIEW_HEADING, parseReviewLog } from '../../../cards/services/review-log.js';
import { isErr } from '../../../shared/result.js';
import type { CardId } from '../../../shared/schemas/common.js';
import { createBoardDependencies } from '../../composition.js';
import type { MrStateProvider } from '../../services/mr-state-provider.js';
import type { ForgeConnection } from '../../models/mr-state.js';
import { runDecideCli, type DecideCliDependencies } from '../decide-cli.js';

// ============================================================
// テスト用プロジェクトの組み立て。git は使わず、ファイルのリポジトリで直に読み書きする
// ============================================================

let root: string;
let dataDir: string;
let stdout: string;
let stderr: string;

const NOW = new Date('2026-11-04T00:00:00.000Z');

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-decide-'));
  dataDir = path.join(root, 'data');
  stdout = '';
  stderr = '';
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

async function writePlan(id: string): Promise<void> {
  const target = path.join(root, '.ai-board', 'plans', `${id}.md`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, '# 計画\n\n- [ ] タスク\n', 'utf-8');
}

const STARTED = "created: '2026-11-01T00:00:00.000Z'\nstartedAt: '2026-11-02T00:00:00.000Z'\n";
const IDEA = (created: string): string => `created: '${created}'\n`;

function review(kind: string): string {
  return `## レビュー\n\n### 2026-11-03T00:00:00.000Z plan ${kind}\n\n理由\n`;
}

function stubProvider(
  connection: ForgeConnection = { status: 'connected', kind: 'github' }
): MrStateProvider {
  return { get: () => null, connection: () => connection, synced: () => true };
}

async function run(argv: readonly string[], provider = stubProvider()): Promise<number> {
  const cards = createFileCardDependencies(dataDir);
  const board = createBoardDependencies(
    path.join(root, '.ai-board', 'plans'),
    cards.cardRepository,
    cards.ideaDividerRepository,
    provider
  );
  const deps: DecideCliDependencies = { loadBoard: board.getBoardQuery, cards };

  return runDecideCli(argv, deps, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    now: () => NOW,
  });
}

async function readCard(id: string) {
  const card = await createFileCardDependencies(dataDir).cardRepository.findById(id as CardId);
  if (card === null) throw new Error(`カードがありません: ${id}`);
  return card;
}

// ============================================================
// テスト
// ============================================================

describe('ai-board decide', () => {
  it('サブコマンドが無ければ使い方を出して 0、知らないものなら 1 で終わる', async () => {
    expect(await run([])).toBe(0);
    expect(stderr).toContain('使い方: ai-board decide');

    stderr = '';
    expect(await run(['merge', 'a'])).toBe(1);
    expect(stderr).toContain('使い方: ai-board decide');
  });

  describe('承認 / 否決 / 中止', () => {
    it('計画レビューのカードを承認すると、plan 承認 を書いて列の移りを出す', async () => {
      await writeCard('a', STARTED, review('提出'));
      await writePlan('a');

      expect(await run(['approve', 'a', '--reason', 'よい'])).toBe(0);

      const entries = parseReviewLog((await readCard('a')).body);
      expect(entries.at(-1)).toMatchObject({ gate: 'plan', kind: '承認', reason: 'よい' });
      expect(entries.at(-1)?.at).toBe(NOW.toISOString());
      expect(stdout).toBe('a: plan 承認 を書きました（計画レビュー → 実装中）\n');
    });

    it('否決は --reason が無ければ拒み、カードを変えない', async () => {
      await writeCard('a', STARTED, review('提出'));
      await writePlan('a');

      expect(await run(['reject', 'a'])).toBe(1);
      expect(stderr).toContain('--reason');
      expect(parseReviewLog((await readCard('a')).body)).toHaveLength(1);

      expect(await run(['reject', 'a', '--reason', '直して'])).toBe(0);
      expect(parseReviewLog((await readCard('a')).body).at(-1)).toMatchObject({
        kind: '否決',
        reason: '直して',
      });
      expect(stdout).toContain('計画レビュー → 計画提案中');
    });

    it('計画レビューのカードは中止できる', async () => {
      await writeCard('a', STARTED, review('提出'));
      await writePlan('a');

      expect(await run(['abort', 'a'])).toBe(0);
      expect(parseReviewLog((await readCard('a')).body).at(-1)).toMatchObject({
        kind: '中止',
        reason: '',
      });
    });

    it('画面で押せない判断（判断を待っていないカードの承認）は、今の列を添えて拒む', async () => {
      await writeCard('a', IDEA('2026-11-01T00:00:00.000Z'));

      expect(await run(['approve', 'a'])).toBe(1);
      expect(stderr).toContain(
        'a に 承認 は書けません（今の列: アイデア。出せる判断はありません）'
      );
      expect((await readCard('a')).body).not.toContain(REVIEW_HEADING);
    });

    it('止まった計画提案中のカードでは、出せる判断の一覧を添えて承認を拒む', async () => {
      await writeCard(
        'a',
        STARTED,
        `${review('提出')}\n### 2026-11-03T01:00:00.000Z plan 否決\n\n理由\n\n### 2026-11-03T02:00:00.000Z plan 保留\n\n止まった\n`
      );

      expect(await run(['approve', 'a'])).toBe(1);
      expect(stderr).toContain('出せる判断: plan 否決 / plan 中止');
    });

    it('GitHub に繋がらないときは承認を拒む', async () => {
      await writeCard('a', STARTED, review('提出'));
      await writePlan('a');

      const offline = stubProvider({ status: 'error', kind: 'github', message: 'gh が無い' });
      expect(await run(['approve', 'a'], offline)).toBe(1);
      expect(stderr).toContain('GitHub に繋がらないので');
      expect(parseReviewLog((await readCard('a')).body)).toHaveLength(1);
    });

    it('カードが無ければ拒む', async () => {
      expect(await run(['approve', 'missing'])).toBe(1);
      expect(stderr).toContain('カードが見つかりません: missing');
    });
  });

  describe('着手 / 着手を戻す', () => {
    it('アイデアに着手すると startedAt を書き、計画提案中に移る', async () => {
      await writeCard('a', IDEA('2026-11-01T00:00:00.000Z'));

      expect(await run(['start', 'a'])).toBe(0);
      expect((await readCard('a')).startedAt).toBe(NOW.toISOString());
      expect(stdout).toBe('a: 着手 を書きました（アイデア → 計画提案中）\n');
    });

    it('計画提案中のカードの着手を戻すと startedAt を消す', async () => {
      await writeCard('a', STARTED);

      expect(await run(['unstart', 'a'])).toBe(0);
      expect((await readCard('a')).startedAt).toBeNull();
      expect(stdout).toContain('計画提案中 → アイデア');
    });

    it('計画レビューのカードは着手を戻せない（下限より前へは戻せない）', async () => {
      await writeCard('a', STARTED, review('提出'));
      await writePlan('a');

      expect(await run(['unstart', 'a'])).toBe(1);
      expect(stderr).toContain('今の列: 計画レビュー');
      expect((await readCard('a')).startedAt).not.toBeNull();
    });

    it('着手済みのカードには着手を書かない', async () => {
      await writeCard('a', STARTED);

      expect(await run(['start', 'a'])).toBe(1);
      expect(stderr).toContain('今の列: 計画提案中');
    });
  });

  describe('飛ばす宣言', () => {
    it('plan を入れて外せる', async () => {
      await writeCard('a', IDEA('2026-11-01T00:00:00.000Z'));

      expect(await run(['skip', 'a', '--gate', 'plan'])).toBe(0);
      expect((await readCard('a')).skipGates).toEqual(['plan']);

      expect(await run(['skip', 'a', '--gate', 'plan', '--remove'])).toBe(0);
      expect((await readCard('a')).skipGates).toEqual([]);
    });

    it('--gate が無いか規定外なら拒む', async () => {
      await writeCard('a', IDEA('2026-11-01T00:00:00.000Z'));

      expect(await run(['skip', 'a'])).toBe(1);
      expect(await run(['skip', 'a', '--gate', 'verify'])).toBe(1);
      expect(stderr).toContain('--gate には plan を指定してください');
    });

    it('中止されたカードには書かない', async () => {
      await writeCard('a', STARTED, review('中止'));

      expect(await run(['skip', 'a', '--gate', 'plan'])).toBe(1);
      expect(stderr).toContain('中止されている');
    });
  });

  describe('並べ替え', () => {
    beforeEach(async () => {
      await writeCard('a', IDEA('2026-11-01T00:00:00.000Z'));
      await writeCard('b', IDEA('2026-11-02T00:00:00.000Z'));
    });

    async function ideaOrder(): Promise<string[]> {
      const cards = await createFileCardDependencies(dataDir).cardRepository.findAll();
      return cards.map((c) => c.id);
    }

    it('カードを先頭へ動かす', async () => {
      expect(await ideaOrder()).toEqual(['a', 'b']);

      expect(await run(['move', 'b', '--after', 'none', '--before', 'a'])).toBe(0);
      expect(await ideaOrder()).toEqual(['b', 'a']);
      expect(stdout).toBe('b: 並べ替えました\n');
    });

    it('アイデアの表に無いカードや、自分自身を隣にする指定は拒む', async () => {
      await writeCard('c', STARTED);

      expect(await run(['move', 'a', '--after', 'c', '--before', 'none'])).toBe(1);
      expect(stderr).toContain('アイデアの表に無いカードです: c');

      expect(await run(['move', 'a', '--after', 'a', '--before', 'none'])).toBe(1);
      expect(stderr).toContain('自分自身');
    });

    it('--after / --before が無ければ拒む', async () => {
      expect(await run(['move', 'a', '--before', 'b'])).toBe(1);
      expect(stderr).toContain('--after に');
    });

    it('区切り線を動かせる。区切り線の指定は --after / --before に受けない', async () => {
      expect(await run(['move-divider', '--after', 'a', '--before', 'b'])).toBe(0);
      expect(stdout).toBe('区切り線を動かしました\n');
      expect(await createFileCardDependencies(dataDir).ideaDividerRepository.get()).not.toBeNull();

      expect(await run(['move-divider', '--after', ':divider', '--before', 'b'])).toBe(1);
      expect(stderr).toContain('カード ID か none');
    });
  });
});
