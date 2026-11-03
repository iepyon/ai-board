import { computeBoardMetrics, type BoardMetrics } from '../../shared/board-metrics.js';
import { groupBySection } from '../../shared/dashboard-sections.js';
import { LOOP_RESULT_LABELS } from '../../shared/loop-step.js';
import { STAGE_LABELS } from '../../shared/stage-labels.js';
import type { StatusCard, StatusReport, WaitingCard, WorkingCard } from './status-cli.js';
import { describeForge, describeLoop, describeNext } from './status-describe.js';
import { escapeHtml } from './html-text.js';
import { formatDuration, renderDailyMergesChart, renderStageChart } from './status-charts.js';

export { escapeHtml };

// ============================================================
// ai-board status --html — ボードを 1 枚の自己完結の HTML にする
// ============================================================

/**
 * ダッシュボードの更新ボタンが、ページを公開したセッションに送る決まった文。
 * `board-dashboard` のスキルはこの文にだけ応える（スキルの文と食い違わないよう、テストで突き合わせる）
 */
export const REFRESH_MESSAGE =
  '[ai-board dashboard refresh] ボードのダッシュボードを出し直して、同じ URL に公開し直してください。';

/** 更新ボタンが呼ぶコネクタと道具（公開のときに `mcp` の機能で宣言するものと同じ） */
export const REFRESH_SERVER = 'Claude Code Remote';
export const REFRESH_TOOL = 'send_message';

/** 頼んだ後、ページが読み直されないままボタンを戻すまでの時間 */
const REFRESH_TIMEOUT_MS = 3 * 60 * 1000;

export interface StatusHtmlOptions {
  /**
   * 更新ボタンが頼む先のセッション ID（`SESSION_ID_PATTERN` で確かめたもの）。
   * null か省略なら、ボタンもスクリプトも入れず、チャットで頼む案内だけを出す
   */
  readonly session?: string | null;
}

/**
 * ボードを 1 枚の HTML（ダッシュボード）にする。クラウドのセッションが Artifact として公開して読む。
 *
 * 頭に集計（主な数字・グラフ・ループの手の表。`board-metrics.ts`）を置き、その下に
 * 画面と同じ `dashboard-sections.ts` の振り分け（`buildStatusReport` が済ませたもの）で区画を並べる。
 * 判断待ちのカードには、待っているゲートの最新のエントリ（提出の本文など）・PR の URL・止まりの理由を出す。
 * 判断のボタンは置かない。判断は会話で頼む。
 *
 * カードのタイトルや理由は人もエージェントも書ける文字なので、すべてエスケープして埋め込み、外部のファイルを読まない。
 * スクリプトは `session` を渡されたときの更新ボタンの分だけで、決まった文をそのセッションに送るほかは何もしない。
 * 時刻は `generatedAt` だけを使い、今の時刻は読まない（純関数）。
 */
export function formatStatusHtml(report: StatusReport, options: StatusHtmlOptions = {}): string {
  const session = options.session ?? null;
  const byId = new Map(report.cards.map((card) => [card.id, card]));
  const sections = groupBySection(report.cards);
  const metrics = computeBoardMetrics(report.cards);

  const body = [
    renderHeader(report, session),
    renderMetrics(metrics),
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
</main>${session === null ? '' : `\n${renderRefreshScript(session)}`}
</body>
</html>
`;
}

// ============================================================
// 区画
// ============================================================

function renderHeader(report: StatusReport, session: string | null): string {
  return `<header>
<div class="title-row">
<h1>ai-board ボード</h1>
${renderRefresh(session)}
</div>
<dl class="meta">
<dt>生成</dt><dd>${escapeHtml(formatTime(report.generatedAt))}</dd>
<dt>GitHub</dt><dd>${escapeHtml(describeForge(report.forge))}</dd>
<dt>ループ</dt><dd>${escapeHtml(describeLoop(report).replace(/^ループ: /, ''))}</dd>
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

  return renderCard(summary, [
    renderRunning(summary),
    hold,
    renderPr(card),
    decisions,
    renderLatestReview(card),
  ]);
}

function renderWorking(summary: WorkingCard, card: StatusCard | undefined): string {
  const tasks = card?.plan ? ` · タスク ${card.plan.tasks.completed}/${card.plan.tasks.total}` : '';
  const stale = summary.stale ? '<span class="stale">動きなし</span>' : '';

  return renderCard(summary, [
    renderRunning(summary),
    `<p class="reason">${escapeHtml(summary.reason)}${escapeHtml(tasks)}${stale}</p>`,
    renderPr(card),
  ]);
}

/** ループが今触っているカードの印 */
function renderRunning(summary: WaitingCard | WorkingCard): string {
  return summary.running ? '<p class="running">AI 稼働中</p>' : '';
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
    const url = escapeHtml(mr.webUrl);
    return `<p class="pr"><span class="label">PR</span><a href="${url}" ${PR_LINK_ATTRIBUTES}>#${mr.iid}</a>${draft} <span class="url">${url}</span></p>`;
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
// 集計
// ============================================================

/** 主な数字の行・工程ごとの滞在時間・日ごとのマージ数・ループの手の表 */
function renderMetrics(metrics: BoardMetrics): string {
  return `<section class="metrics">
<h2>集計</h2>
${renderStats(metrics)}
<h3 class="sub">工程ごとの滞在時間 <span class="count">マージ済みのカード 1 枚あたりの中央値</span></h3>
${renderStageChart(metrics.stages, metrics.bottleneck)}
<h3 class="sub">日ごとのマージ数 <span class="count">UTC</span></h3>
${renderDailyMergesChart(metrics.dailyMerges)}
<h3 class="sub">ループの手</h3>
${renderLoopActions(metrics)}
<h3 class="sub">手の結果</h3>
${renderLoopResults(metrics)}
</section>`;
}

function renderStats(metrics: BoardMetrics): string {
  const { summary } = metrics;
  const duration = (ms: number | null): string => (ms === null ? '—' : formatDuration(ms));
  const share =
    summary.humanShareMedian === null ? '—' : `${Math.round(summary.humanShareMedian * 100)}%`;

  const stats: readonly (readonly [string, string])[] = [
    ['マージ済み', `${summary.mergedCount} 枚`],
    ['着手からマージ（中央値）', duration(summary.leadTimeMedianMs)],
    ['着手からマージ（最長）', duration(summary.leadTimeMaxMs)],
    ['人の番の割合（中央値）', share],
    ['否決', `${summary.rejectedCardCount} 枚・${summary.rejectionCount} 回`],
    ['アイデアの残り', `${summary.ideaCount} 枚`],
  ];

  return `<dl class="stats">
${stats
  .map(
    ([label, value]) =>
      `<div class="stat"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
  )
  .join('\n')}
</dl>`;
}

function renderLoopActions(metrics: BoardMetrics): string {
  if (metrics.loopActions.length === 0) return '<p class="empty">まだありません</p>';

  const rows = metrics.loopActions.map((entry) => {
    const name = entry.step === null ? entry.action : `${entry.action} · ${entry.step}`;
    const duration = entry.avgDurationMs === null ? '—' : formatDuration(entry.avgDurationMs);
    const tokens =
      entry.avgTokens === null ? '—' : Math.round(entry.avgTokens).toLocaleString('en-US');

    return `<tr><th scope="row">${escapeHtml(name)}</th><td>${entry.count}</td><td>${escapeHtml(
      duration + missing(entry.missingDuration)
    )}</td><td>${escapeHtml(tokens + missing(entry.missingTokens))}</td></tr>`;
  });

  return `<div class="table-wrap"><table class="loop">
<thead><tr><th scope="col">手</th><th scope="col">回数</th><th scope="col">平均時間</th><th scope="col">平均トークン</th></tr></thead>
<tbody>
${rows.join('\n')}
</tbody>
</table></div>`;
}

/** 平均から除いた件数の注記 */
function missing(count: number): string {
  return count === 0 ? '' : `（記録なし ${count}）`;
}

function renderLoopResults(metrics: BoardMetrics): string {
  if (metrics.loopResults.length === 0) return '<p class="empty">まだありません</p>';

  const items = metrics.loopResults.map((entry) => {
    const label = entry.result === 'running' ? '実行中' : LOOP_RESULT_LABELS[entry.result];
    return `<li>${escapeHtml(label)} <span class="count">${entry.count}</span></li>`;
  });

  return `<ul class="results">\n${items.join('\n')}\n</ul>`;
}

// ============================================================
// 更新ボタン
// ============================================================

/** チャットで頼む案内。ボタンが使えないとき（`session` が無い、コネクタが使えない、頼んでも読み直されない）に出す */
const REFRESH_GUIDE = '最新にするには、チャットで「ボードを見せて」と頼んでください。';

/**
 * ヘッダの右上の更新ボタン。`session` が無ければボタンを入れず案内の文だけを出す。
 * ボタンは隠しておき、スクリプトが `mcp` を使えると分かってから出す
 */
function renderRefresh(session: string | null): string {
  const guide = `<p class="refresh-guide" id="refresh-guide">${escapeHtml(REFRESH_GUIDE)}</p>`;
  if (session === null) return `<div class="refresh">${guide}</div>`;

  return `<div class="refresh">
<button type="button" id="refresh-button" hidden>更新</button>
${guide}
</div>`;
}

/**
 * 更新ボタンのスクリプト。`claude.use("mcp")` で `Claude Code Remote` の `send_message` を呼び、
 * 埋め込んだセッションに `REFRESH_MESSAGE` を送るだけで、ボードのデータには触らない。
 *
 * 値は JSON にして `<` を Unicode のエスケープ（u003c）に直して埋め込み、`</script>` で抜けられないようにする。
 */
function renderRefreshScript(session: string): string {
  const config = scriptJson({
    session,
    message: REFRESH_MESSAGE,
    server: REFRESH_SERVER,
    tool: REFRESH_TOOL,
    timeoutMs: REFRESH_TIMEOUT_MS,
  });

  return `<script>
(function () {
  var config = ${config};
  var button = document.getElementById('refresh-button');
  var guide = document.getElementById('refresh-guide');
  if (!button || !guide) return;

  function showGuide() {
    button.hidden = true;
    guide.hidden = false;
  }

  function reset() {
    button.disabled = false;
    button.textContent = '更新';
    guide.hidden = false;
  }

  if (!window.claude || typeof window.claude.use !== 'function') return;

  window.claude.use('mcp').then(function (mcp) {
    if (!mcp) return showGuide();
    button.hidden = false;
    guide.hidden = true;
    button.addEventListener('click', function () {
      if (button.disabled) return;
      button.disabled = true;
      button.textContent = '更新を頼みました';
      mcp.callTool(config.server, config.tool, { session_id: config.session, message: config.message }, { cache: false })
        .then(function () { setTimeout(reset, config.timeoutMs); }, showGuide);
    });
  }, showGuide);
})();
</script>`;
}

/** スクリプトに埋め込む JSON。`<` を逃がして `</script>` や `<!--` で抜けられないようにする */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

// ============================================================
// 文字の扱い
// ============================================================

/**
 * PR のリンクの属性。Artifact の中では `target="_blank"` が開かなかったので、外側の窓で開く `_top` にする。
 * 開かない場合に備えて、リンクの隣に URL を文字でも出す
 */
export const PR_LINK_ATTRIBUTES = 'target="_top" rel="noreferrer"';

/** リンクにしてよい URL。`javascript:` などは文字のまま残す（`markdown.ts` の `SAFE_HREF` と同じ規則） */
const SAFE_HREF = /^https?:\/\//i;

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
  --chart-human: #bf5b04; --chart-ai: #0969da; --chart-merged: #1a7f37; --chart-axis: #afb8c1;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0d1117; --surface: #161b22; --text: #e6edf3; --muted: #8d96a0;
    --border: #30363d; --accent: #4493f8; --warn-bg: #3a2a12; --warn: #f0b45a;
    --stage-bg: #21262d; --code-bg: #1f242c;
    --chart-human: #f0883e; --chart-ai: #4493f8; --chart-merged: #3fb950; --chart-axis: #484f58;
  }
}
:root[data-theme="dark"] {
  --bg: #0d1117; --surface: #161b22; --text: #e6edf3; --muted: #8d96a0;
  --border: #30363d; --accent: #4493f8; --warn-bg: #3a2a12; --warn: #f0b45a;
  --stage-bg: #21262d; --code-bg: #1f242c;
  --chart-human: #f0883e; --chart-ai: #4493f8; --chart-merged: #3fb950; --chart-axis: #484f58;
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
.running {
  display: inline-block; color: var(--accent); border: 1px solid var(--accent); border-radius: 4px;
  padding: 0 6px; font-size: 0.8rem;
}
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
.title-row { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 8px; }
.refresh { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; max-width: 100%; }
.refresh button {
  font: inherit; color: #ffffff; background: var(--accent); border: 0; border-radius: 6px;
  padding: 4px 14px; cursor: pointer;
}
.refresh button:disabled { opacity: 0.6; cursor: default; }
.refresh-guide { margin: 0; color: var(--muted); font-size: 0.8rem; overflow-wrap: anywhere; }
.pr .url { color: var(--muted); font-size: 0.8rem; overflow-wrap: anywhere; }
h3.sub { font-size: 0.95rem; margin: 18px 0 6px; }
.stats {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; margin: 0;
}
.stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; }
.stat dt { color: var(--muted); font-size: 0.78rem; }
.stat dd { margin: 0; font-size: 1.15rem; font-weight: 600; overflow-wrap: anywhere; }
.chart { display: block; width: 100%; height: auto; }
.chart text { fill: var(--text); font-size: 12px; }
.chart .label { fill: var(--muted); }
.chart .value-bottleneck { font-weight: 700; }
.chart .bar-human { fill: var(--chart-human); }
.chart .bar-ai { fill: var(--chart-ai); }
.chart .bar-merged { fill: var(--chart-merged); }
.chart .bar-bottleneck { stroke: var(--text); stroke-width: 2; }
.chart .axis { stroke: var(--chart-axis); stroke-width: 1; }
.table-wrap { overflow-x: auto; }
table.loop { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
table.loop th, table.loop td { border-bottom: 1px solid var(--border); padding: 4px 8px; text-align: right; white-space: nowrap; }
table.loop th[scope="row"], table.loop thead th:first-child { text-align: left; }
.results { display: flex; flex-wrap: wrap; gap: 4px 16px; padding: 0; margin: 0; list-style: none; }
`;
