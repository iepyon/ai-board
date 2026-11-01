import { groupBySection } from '../../shared/dashboard-sections.js';
import { STAGE_LABELS } from '../../shared/stage-labels.js';
import type { StatusCard, StatusReport, WaitingCard, WorkingCard } from './status-cli.js';
import { describeForge, describeNext } from './status-describe.js';

// ============================================================
// ai-board status --html — ボードを 1 枚の自己完結の HTML にする
// ============================================================

/**
 * ボードを 1 枚の HTML にする。クラウドのセッションが Artifact として公開して読む。
 *
 * 区画と並びは画面と同じ `dashboard-sections.ts` の振り分け（`buildStatusReport` が済ませたもの）に従う。
 * 判断待ちのカードには、待っているゲートの最新のエントリ（提出の本文など）・PR の URL・止まりの理由を出す。
 * ボタンは置かない。判断は会話で頼む。
 *
 * カードのタイトルや理由は人もエージェントも書ける文字なので、すべてエスケープして埋め込み、
 * スクリプトも外部のファイルも読まない。時刻は `generatedAt` だけを使い、今の時刻は読まない（純関数）。
 */
export function formatStatusHtml(report: StatusReport): string {
  const byId = new Map(report.cards.map((card) => [card.id, card]));
  const sections = groupBySection(report.cards);

  const body = [
    renderHeader(report),
    renderSection(
      '判断待ち',
      report.waiting.length,
      report.waiting.map((summary) => renderWaiting(summary, byId.get(summary.id)))
    ),
    renderSection(
      'AI 作業中',
      report.working.length,
      report.working.map((summary) => renderWorking(summary, byId.get(summary.id)))
    ),
    renderIdeas(report),
    renderSection('マージ済み', sections.merged.length, sections.merged.map(renderMerged)),
    renderSection('中止', sections.aborted.length, sections.aborted.map(renderAborted)),
  ].join('\n');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ai-board ボード</title>
<style>${STYLE}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

// ============================================================
// 区画
// ============================================================

function renderHeader(report: StatusReport): string {
  return `<header>
<h1>ai-board ボード</h1>
<dl class="meta">
<dt>生成</dt><dd>${escapeHtml(formatTime(report.generatedAt))}</dd>
<dt>GitHub</dt><dd>${escapeHtml(describeForge(report.forge))}</dd>
<dt>次の一手</dt><dd>${escapeHtml(describeNext(report.next, report.forge))}</dd>
</dl>
</header>`;
}

function renderSection(title: string, count: number, items: readonly string[]): string {
  const content = items.length === 0 ? '<p class="empty">ありません</p>' : items.join('\n');

  return `<section>
<h2>${escapeHtml(title)} <span class="count">${count}</span></h2>
${content}
</section>`;
}

function renderWaiting(summary: WaitingCard, card: StatusCard | undefined): string {
  const hold =
    card?.hold != null
      ? `<p class="hold"><span class="label">止まり</span>${escapeHtml(card.hold.reason)}</p>`
      : `<p class="reason">${escapeHtml(summary.reason)}</p>`;
  const decisions =
    summary.decisions.length === 0
      ? ''
      : `<p class="decisions"><span class="label">判断</span>${summary.decisions
          .map((decision) => escapeHtml(decision.label))
          .join(' / ')}</p>`;

  return renderCard(summary, [hold, renderPr(card), decisions, renderLatestReview(card)]);
}

function renderWorking(summary: WorkingCard, card: StatusCard | undefined): string {
  const tasks = card?.plan ? ` · タスク ${card.plan.tasks.completed}/${card.plan.tasks.total}` : '';
  const stale = summary.stale ? '<span class="stale">動きなし</span>' : '';

  return renderCard(summary, [
    `<p class="reason">${escapeHtml(summary.reason)}${escapeHtml(tasks)}${stale}</p>`,
    renderPr(card),
  ]);
}

function renderIdeas(report: StatusReport): string {
  const count = report.ideas.filter((row) => !('divider' in row)).length;
  if (count === 0) return renderSection('アイデア', 0, []);

  const rows = report.ideas.map((row) =>
    'divider' in row
      ? '<li class="divider">ここから下は、あとで考える</li>'
      : `<li>${escapeHtml(row.title)} <code>${escapeHtml(row.id)}</code></li>`
  );

  return renderSection('アイデア', count, [`<ul class="ideas">\n${rows.join('\n')}\n</ul>`]);
}

function renderMerged(card: StatusCard): string {
  const at = card.mrState?.mergedAt ?? card.plan?.updatedAt ?? null;
  const when = at === null ? '' : `<p class="reason">${escapeHtml(formatTime(at))}</p>`;

  return renderCard(card, [when, renderPr(card)]);
}

function renderAborted(card: StatusCard): string {
  return renderCard(card, []);
}

// ============================================================
// カード
// ============================================================

function renderCard(
  card: Pick<StatusCard, 'id' | 'title' | 'stage'>,
  parts: readonly string[]
): string {
  const content = parts.filter((part) => part !== '').join('\n');

  return `<article>
<h3><span class="stage">${escapeHtml(STAGE_LABELS[card.stage])}</span>${escapeHtml(card.title)}</h3>
<p class="id"><code>${escapeHtml(card.id)}</code></p>
${content}
</article>`;
}

/** PR の URL。`http(s)` でなければリンクにせず番号の文字だけを出す */
function renderPr(card: StatusCard | undefined): string {
  if (card === undefined) return '';

  const mr = card.mrState;
  if (mr !== null && SAFE_HREF.test(mr.webUrl)) {
    const draft = mr.draft ? '（Draft）' : '';
    return `<p class="pr"><span class="label">PR</span><a href="${escapeHtml(mr.webUrl)}" target="_blank" rel="noreferrer">#${mr.iid}</a>${draft}</p>`;
  }

  const iid = mr?.iid ?? card.mr;

  return iid === null ? '' : `<p class="pr"><span class="label">PR</span>#${iid}</p>`;
}

/**
 * 待っているゲートの最新のエントリ。計画レビューと動作確認では提出の本文（AI が書いた判断してほしい点）、
 * 止まっているカードでは保留の理由になる。本文は Markdown のまま、改行を保って出す
 */
function renderLatestReview(card: StatusCard | undefined): string {
  const review = card?.latestReview;
  if (!review || review.reason.trim() === '') return '';

  const summary = `${review.gate} ${review.kind} · ${formatTime(review.at)}`;

  return `<details open>
<summary>${escapeHtml(summary)}</summary>
<div class="review">${escapeHtml(review.reason)}</div>
</details>`;
}

// ============================================================
// 文字の扱い
// ============================================================

/** リンクにしてよい URL。`javascript:` などは文字のまま残す（`markdown.ts` の `SAFE_HREF` と同じ規則） */
const SAFE_HREF = /^https?:\/\//i;

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** 本文・属性のどちらに埋め込んでも安全な形にする */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** `2026-10-20 09:00 UTC`。解釈できない値はそのまま返す（どの環境でも同じ文字になるよう UTC で出す） */
function formatTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;

  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const STYLE = `
:root {
  --bg: #f7f7f5; --surface: #ffffff; --text: #1f2328; --muted: #656d76;
  --border: #d8dee4; --accent: #0969da; --warn-bg: #fff4e5; --warn: #9a4d00;
  --stage-bg: #eef1f4; --code-bg: #f0f2f4;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0d1117; --surface: #161b22; --text: #e6edf3; --muted: #8d96a0;
    --border: #30363d; --accent: #4493f8; --warn-bg: #3a2a12; --warn: #f0b45a;
    --stage-bg: #21262d; --code-bg: #1f242c;
  }
}
:root[data-theme="dark"] {
  --bg: #0d1117; --surface: #161b22; --text: #e6edf3; --muted: #8d96a0;
  --border: #30363d; --accent: #4493f8; --warn-bg: #3a2a12; --warn: #f0b45a;
  --stage-bg: #21262d; --code-bg: #1f242c;
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif;
}
main { max-width: 860px; margin: 0 auto; padding: 16px; }
h1 { font-size: 1.4rem; margin: 0 0 8px; }
h2 { font-size: 1.1rem; margin: 28px 0 10px; border-bottom: 1px solid var(--border); padding-bottom: 4px; }
h3 { font-size: 1rem; margin: 0; overflow-wrap: anywhere; }
.count { color: var(--muted); font-weight: normal; }
.meta { display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; margin: 0; color: var(--muted); }
.meta dd { margin: 0; color: var(--text); overflow-wrap: anywhere; }
article {
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 12px; margin: 0 0 10px;
}
article p { margin: 4px 0; overflow-wrap: anywhere; }
.stage {
  display: inline-block; font-size: 0.75rem; font-weight: normal; background: var(--stage-bg);
  border-radius: 4px; padding: 0 6px; margin-right: 8px; vertical-align: 2px;
}
.id { color: var(--muted); font-size: 0.85rem; }
code { background: var(--code-bg); border-radius: 4px; padding: 0 4px; font-size: 0.85em; }
.label { color: var(--muted); font-size: 0.8rem; margin-right: 8px; }
.hold { background: var(--warn-bg); color: var(--warn); border-radius: 6px; padding: 6px 8px; }
.hold .label { color: inherit; }
.stale { color: var(--warn); margin-left: 8px; font-size: 0.85rem; }
a { color: var(--accent); }
details { margin-top: 8px; }
summary { cursor: pointer; color: var(--muted); font-size: 0.85rem; }
.review {
  white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.9rem;
  border-left: 3px solid var(--border); padding: 4px 0 4px 10px; margin-top: 6px;
}
.ideas { padding-left: 1.6em; margin: 0; }
.ideas li { margin: 2px 0; overflow-wrap: anywhere; }
.ideas .divider { list-style: none; margin: 8px 0 8px -1.6em; color: var(--muted); font-size: 0.85rem; border-top: 1px dashed var(--border); padding-top: 4px; }
.empty { color: var(--muted); }
`;
