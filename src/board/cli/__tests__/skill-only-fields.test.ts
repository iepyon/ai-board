import { promises as fs, readdirSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileCardDependencies } from '../../../cards/composition.js';
import { parseCard } from '../../../cards/repositories/card-markdown.js';
import { REVIEW_HEADING, parseReviewLog } from '../../../cards/services/review-log.js';
import { isErr } from '../../../shared/result.js';
import { createBoardDependencies, createLoopHistoryRepository } from '../../composition.js';
import { runStatusCli } from '../status-cli.js';
import type { PrStateProvider } from '../../services/pr-state-provider.js';
import { createGetStatusQuery } from '../../usecases/queries/get-status.query.js';

/**
 * スキルと agent の手順書が `ai-board status --json --only <値>` で指す項目が、`status` の出力から消えていないことを守る。
 *
 * `--only` は入れ子の項目名（`cards.latestReview` の `latestReview`）を検査せず、要素に無い項目を黙って出さない（`pickFields`）。
 * 内部のモデルの名前を変えると、スキルはエラーにならないまま項目を読めなくなるので、手順書に書かれた値を試しのボードで実際に走らせて確かめる。
 * 中身として読む深い項目（`prState.webUrl` など）は守らない。
 */

const CLAUDE_DIR = fileURLToPath(new URL('../../../../.claude/', import.meta.url));
const MANUAL_DIRS = ['skills', 'agents'];

/** `--only` の直後の値。`<項目,...>` のような書き方の説明や、`` `--only` `` のような語としての言及は拾わない */
const ONLY_PATTERN = /--only\s+([A-Za-z][A-Za-z0-9_.,]*)/g;

interface OnlyUsage {
  readonly value: string;
  readonly where: string;
}

function listManuals(): string[] {
  return MANUAL_DIRS.flatMap((dir) =>
    readdirSync(path.join(CLAUDE_DIR, dir), { recursive: true, encoding: 'utf-8' })
      .filter((file) => file.endsWith('.md'))
      .map((file) => path.join(dir, file))
  );
}

function collectOnlyUsages(): OnlyUsage[] {
  return listManuals().flatMap((file) =>
    readFileSync(path.join(CLAUDE_DIR, file), 'utf-8')
      .split('\n')
      .flatMap((line, index) =>
        [...line.matchAll(ONLY_PATTERN)].map((match) => ({
          value: match[1] ?? '',
          where: `.claude/${file}:${index + 1}`,
        }))
      )
  );
}

// ============================================================
// 試しのボード（判断待ち・AI 作業中・アイデアに 1 枚ずつ）
// ============================================================

let root: string;
let dataDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-skill-only-'));
  dataDir = path.join(root, 'data');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  await writeCard('started', "startedAt: '2026-10-22T00:00:00.000Z'\n");
  await writeCard(
    'reviewing',
    "startedAt: '2026-10-21T00:00:00.000Z'\n",
    '## レビュー\n\n### 2026-10-21T01:00:00.000Z plan 提出\n'
  );
  await writePlan('reviewing', '# 計画\n\n- [ ] 1');
  await writeCard('idea', '');
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

  // 新しいカードの本文に判断があると、ファイルのリポジトリは書かずに拒む。判断は 1 件ずつ足す
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

const connected: PrStateProvider = {
  get: () => null,
  connection: () => ({ status: 'connected', kind: 'github' }),
  synced: () => true,
  failure: () => null,
};

async function runStatus(
  argv: readonly string[]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const cards = createFileCardDependencies(dataDir);
  const board = createBoardDependencies(
    path.join(root, '.ai-board', 'plans'),
    cards.cardRepository,
    cards.ideaDividerRepository,
    connected,
    createLoopHistoryRepository(dataDir)
  );

  let stdout = '';
  let stderr = '';
  const code = await runStatusCli(
    argv,
    { getStatusQuery: createGetStatusQuery(board.getBoardQuery) },
    {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      now: () => new Date('2026-10-23T00:00:00.000Z'),
    }
  );
  return { code, stdout, stderr };
}

// ============================================================
// 手順書の --only
// ============================================================

const usages = collectOnlyUsages();

describe('手順書の status --json --only', () => {
  it('手順書から --only の値を 1 件以上拾える（拾えなければ、何も確かめずに通ってしまう）', () => {
    expect(usages.length).toBeGreaterThan(0);
  });

  it.each(usages.map((usage) => [usage.where, usage.value] as const))(
    '%s の --only %s が指す項目は、status の出力に入っている',
    async (_where, value) => {
      const { code, stdout, stderr } = await runStatus(['--json', '--only', value]);

      expect(stderr).toBe('');
      expect(code).toBe(0);

      const report = JSON.parse(stdout) as Record<string, unknown>;
      for (const item of value.split(',')) {
        const [key = '', field] = item.split('.');
        expect(report, `最上位の ${key} が無い`).toHaveProperty([key]);
        if (field === undefined) continue;

        const elements = report[key] as Record<string, unknown>[];
        expect(
          elements.length,
          `試しのボードに ${key} の要素が無く、${item} を確かめられない`
        ).toBeGreaterThan(0);
        for (const element of elements) {
          expect(Object.keys(element), `${item} が ${key} の要素に無い`).toContain(field);
        }
      }
    }
  );
});
