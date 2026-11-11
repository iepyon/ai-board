#!/usr/bin/env node
// ============================================================
// board-view — `ai-board status --json --active` を、ボードのページ（template.html）に流し込む
// ============================================================
//
// 使い方（スキルの手順から走らせる。dist/ はビルド済みであること）:
//   node dist/cli.js status --json --active | node .claude/skills/board-view/render.mjs > board-view.html
//
// ページは描くだけで、区画・並び・ステージは status が決めたものをそのまま使う。
// 文言（「GitHub:」「ループ:」「次の一手:」）とステージの名前は、人向けの status と同じ本体の関数で作る。
// テストは純関数（buildPageData / renderHtml）だけを import し、文言の関数に src/ のものを渡す。

import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** ひな形の中の、データを流し込む印 */
export const MARKER = '/*__BOARD__*/null';

/** `status --json --active` に要る最上位の項目 */
const REQUIRED_KEYS = ['waiting', 'working', 'ideas', 'cards', 'forge', 'loop', 'generatedAt'];

/** そのうち配列であるもの */
const LIST_KEYS = ['waiting', 'working', 'ideas', 'cards'];

/**
 * 報告（`status --json --active` の出力）から、ページが描くだけのデータを作る。
 * `helpers` は `{ describeForge, describeLoop, describeNext, stageLabels }`。
 * 必要な項目が無ければ例外を投げる（スクリプトの入口が 1 行の誤りにする）
 */
export function buildPageData(report, helpers) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('ボードの JSON ではありません');
  }
  for (const key of REQUIRED_KEYS) {
    if (!(key in report)) throw new Error(`ボードの JSON に ${key} がありません`);
  }
  for (const key of LIST_KEYS) {
    if (!Array.isArray(report[key])) throw new Error(`ボードの JSON の ${key} が配列ではありません`);
  }

  const prUrls = new Map(report.cards.map((card) => [card.id, httpsUrl(card.prState?.webUrl)]));
  const summary = (card) => ({
    id: card.id,
    title: card.title,
    stageLabel: helpers.stageLabels[card.stage] ?? card.stage,
    reason: card.reason,
    running: card.running === true,
    prUrl: prUrls.get(card.id) ?? null,
  });

  return {
    generatedAt: report.generatedAt,
    header: {
      // 人向けの status（status-cli.ts の formatStatus）と同じ前置きを付ける。describeLoop は「ループ:」を含む
      forge: `GitHub: ${helpers.describeForge(report.forge)}`,
      loop: helpers.describeLoop(report),
      next: `次の一手: ${helpers.describeNext(report.next ?? null, report.forge)}`,
    },
    waiting: report.waiting.map((card) => ({
      ...summary(card),
      decisions: (card.decisions ?? []).map((decision) => decision.label),
    })),
    working: report.working.map((card) => ({ ...summary(card), stale: card.stale === true })),
    ideas: report.ideas.map((row) =>
      row.divider === true ? { divider: true } : { id: row.id, title: row.title }
    ),
  };
}

/** `https://` で始まる URL だけを返す。ほかは null（リンクにしない） */
function httpsUrl(value) {
  return typeof value === 'string' && value.startsWith('https://') ? value : null;
}

/**
 * `<script>` の中に置ける JSON にする。
 * `<` を逃がして `</script>` や `<!--` で抜け出さないようにし、U+2028 / U+2029 も逃がす
 */
export function embedJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** ひな形の印をデータに置き換える。印が無ければ例外を投げる */
export function renderHtml(template, data) {
  if (!template.includes(MARKER)) throw new Error('ひな形にデータの印がありません');
  // 置き換えの文字列の `$&` などを解釈させないよう、関数で渡す
  return template.replace(MARKER, () => embedJson(data));
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dist = path.resolve(here, '../../../dist');
  const describe = await import(pathToFileURL(path.join(dist, 'board/cli/status-describe.js')).href);
  const labels = await import(pathToFileURL(path.join(dist, 'shared/stage-labels.js')).href);

  const report = JSON.parse(readFileSync(0, 'utf-8'));
  const template = readFileSync(path.join(here, 'template.html'), 'utf-8');
  const data = buildPageData(report, {
    describeForge: describe.describeForge,
    describeLoop: describe.describeLoop,
    describeNext: describe.describeNext,
    stageLabels: labels.STAGE_LABELS,
  });

  process.stdout.write(renderHtml(template, data));
}

/**
 * `moduleUrl` のモジュールが、`argv1` の道筋で直接走らされたか。
 * Node は main のモジュールの URL をシンボリックリンクを解いた実パスで持つので、`argv1` も実パスにしてから比べる
 * （解かないと、リンクを通して走らせたときに何も出さず終了コード 0 で終わる）。実パスにできなければ偽
 */
export function isInvokedDirectly(moduleUrl, argv1) {
  if (argv1 === undefined) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(path.resolve(argv1))).href;
  } catch {
    return false;
  }
}

if (isInvokedDirectly(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`board-view: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
