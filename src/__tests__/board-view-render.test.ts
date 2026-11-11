import { mkdtempSync, realpathSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { describeForge, describeLoop, describeNext } from '../board/presenters/status-describe.js';
import { STAGE_LABELS } from '../shared/stage-labels.js';

/**
 * `.claude/skills/board-view/render.mjs`（`status --json --active` をボードのページに流し込む）を確かめる。
 *
 * CI はビルドの前にテストを走らせるので、スクリプトの純関数だけを import し、
 * 文言の関数には `src/` のものを渡す（直接走らせたときの `dist/` の import は動作確認で見る）。
 */

const SKILL_DIR = new URL('../../.claude/skills/board-view/', import.meta.url);
const TEMPLATE = readFileSync(fileURLToPath(new URL('template.html', SKILL_DIR)), 'utf-8');

interface PageCard {
  id: string;
  title: string;
  stageLabel: string;
  reason: string;
  running: boolean;
  prUrl: string | null;
  decisions?: string[];
  stale?: boolean;
}

interface PageData {
  generatedAt: string;
  header: { forge: string; loop: string; next: string };
  waiting: PageCard[];
  working: PageCard[];
  ideas: ({ id: string; title: string } | { divider: true })[];
}

interface RenderModule {
  MARKER: string;
  buildPageData(report: unknown, helpers: unknown): PageData;
  renderHtml(template: string, data: unknown): string;
  isInvokedDirectly(moduleUrl: string, argv1: string | undefined): boolean;
}

async function loadRender(): Promise<RenderModule> {
  // 変数で渡すと tsc は .mjs の型を探さない
  const specifier = new URL('render.mjs', SKILL_DIR).href;
  return (await import(specifier)) as RenderModule;
}

const helpers = { describeForge, describeLoop, describeNext, stageLabels: STAGE_LABELS };

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    next: null,
    waiting: [
      {
        id: 'reviewing',
        title: '計画を見てほしい',
        stage: 'plan-review',
        reason: '計画の PR #9（Draft）が人の承認を待っている',
        running: false,
        decisions: [
          { gate: 'plan', kind: '承認', label: '承認', reasonRequired: false },
          { gate: 'plan', kind: '差し戻し', label: '差し戻す', reasonRequired: true },
        ],
      },
    ],
    working: [
      {
        id: 'building',
        title: '実装している',
        stage: 'impling',
        reason: '計画が承認されている',
        running: true,
        stale: false,
      },
    ],
    cards: [
      {
        id: 'reviewing',
        title: '計画を見てほしい',
        prState: { webUrl: 'https://github.com/a/b/pull/9' },
      },
      { id: 'building', title: '実装している', prState: { webUrl: 'javascript:alert(1)' } },
    ],
    ideas: [
      { id: 'next-one', title: '次にやる' },
      { divider: true },
      { id: 'later-one', title: '後で' },
    ],
    forge: { status: 'connected', kind: 'github' },
    loop: { running: [], lastFinishedAt: null },
    generatedAt: '2026-11-07T00:00:00.000Z',
    ...overrides,
  };
}

describe('board-view の render.mjs', () => {
  it('区画・文言・ステージの名前・出せる判断を、ページが描くだけのデータにする', async () => {
    const { buildPageData } = await loadRender();
    const data = buildPageData(report(), helpers);

    const forge = { status: 'connected', kind: 'github' } as const;
    expect(data.header.forge).toBe(`GitHub: ${describeForge(forge)}`);
    expect(data.header.next).toBe(`次の一手: ${describeNext(null, forge)}`);
    expect(data.header.loop).toMatch(/^ループ: /);
    expect(data.waiting).toEqual([
      expect.objectContaining({
        id: 'reviewing',
        stageLabel: '計画レビュー',
        decisions: ['承認', '差し戻す'],
        prUrl: 'https://github.com/a/b/pull/9',
      }),
    ]);
    expect(data.working).toEqual([
      expect.objectContaining({
        id: 'building',
        stageLabel: '実装中',
        running: true,
        stale: false,
      }),
    ]);
    expect(data.ideas).toEqual([
      { id: 'next-one', title: '次にやる' },
      { divider: true },
      { id: 'later-one', title: '後で' },
    ]);
  });

  it('PR のリンクは https:// の URL だけにする', async () => {
    const { buildPageData } = await loadRender();
    const data = buildPageData(report(), helpers);

    expect(data.working[0]?.prUrl).toBeNull();
  });

  it('必要な項目が無い・JSON のオブジェクトでない入力は誤りにする', async () => {
    const { buildPageData } = await loadRender();

    expect(() => buildPageData({}, helpers)).toThrow('waiting');
    expect(() => buildPageData(report({ ideas: 'x' }), helpers)).toThrow('ideas');
    expect(() => buildPageData([], helpers)).toThrow('ボードの JSON ではありません');
    expect(() => buildPageData(null, helpers)).toThrow('ボードの JSON ではありません');
  });

  it('ひな形の印にデータを流し込み、タイトルの </script> で抜け出さない', async () => {
    const { buildPageData, renderHtml, MARKER } = await loadRender();
    expect(TEMPLATE).toContain(MARKER);

    const evil = '</script><script>alert(1)</script>$&\u2028';
    const html = renderHtml(
      TEMPLATE,
      buildPageData(report({ ideas: [{ id: 'evil', title: evil }] }), helpers)
    );

    expect(html).not.toContain(MARKER);
    const script = html.slice(html.lastIndexOf('<script>') + '<script>'.length);
    expect(script.indexOf('</script>')).toBe(script.lastIndexOf('</script>'));
    expect(html).toContain('\\u003c/script>');
    expect(html).toContain('$&');
    expect(html).not.toContain('\u2028');
  });

  it('ひな形に印が無ければ誤りにする', async () => {
    const { renderHtml } = await loadRender();

    expect(() => renderHtml('<p>印なし</p>', {})).toThrow('印');
  });

  it('シンボリックリンクを通った道筋で走らせても、直接走らされたと分かる', async () => {
    const { isInvokedDirectly } = await loadRender();
    const skillDir = realpathSync(fileURLToPath(SKILL_DIR));
    const moduleUrl = pathToFileURL(path.join(skillDir, 'render.mjs')).href;
    const dir = mkdtempSync(path.join(tmpdir(), 'board-view-'));
    try {
      const link = path.join(dir, 'skill');
      symlinkSync(skillDir, link);

      expect(isInvokedDirectly(moduleUrl, path.join(skillDir, 'render.mjs'))).toBe(true);
      expect(isInvokedDirectly(moduleUrl, path.join(link, 'render.mjs'))).toBe(true);
      expect(isInvokedDirectly(moduleUrl, path.join(dir, 'missing.mjs'))).toBe(false);
      expect(isInvokedDirectly(moduleUrl, undefined)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
