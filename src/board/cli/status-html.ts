import {
  computeBoardMetrics,
  type BoardMetrics,
  type HarnessVersionMetrics,
} from '../../shared/board-metrics.js';
import { buildBoardLog, type BoardLogEntry } from '../../shared/board-log.js';
import { groupBySection } from '../../shared/dashboard-sections.js';
import {
  describeAction,
  describeResult,
  formatDurationMs,
  formatTokens,
  runningStepOf,
} from '../../shared/loop-activity.js';
import { LOOP_RESULT_LABELS } from '../../shared/loop-step.js';
import { DATA_BRANCH } from '../../infrastructure/data-store.js';
import { STAGE_LABELS } from '../../shared/stage-labels.js';
import type { StatusCard, StatusReport, WaitingCard, WorkingCard } from './status-cli.js';
import { describeForge, describeLoop, describeNext, describeStuck } from './status-describe.js';
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
  /**
   * カードの詳細へのリンクを作る GitHub のリポジトリ（設定の `github.repository`）。
   * null か省略なら、カードの詳細へのリンクを出さない
   */
  readonly repository?: CardRepository | null;
}

/** カードのファイルを置いた GitHub のリポジトリ */
export interface CardRepository {
  readonly owner: string;
  readonly repo: string;
}

/**
 * ボードを 1 枚の HTML（ダッシュボード）にする。クラウドのセッションが Artifact として公開して読む。
 *
 * 頭（生成の時刻・ループ・次の一手・更新ボタン）の下を、使う場面ごとに 3 つのタブに分ける。
 * タブはラジオボタンと CSS だけで切り替え、スクリプトに頼らない（`session` が無いページにもスクリプトを入れないため）。
 *
 * - 今: 判断待ち・AI 作業中（今の手）・アイデア。画面と同じ `dashboard-sections.ts` の振り分け（`buildStatusReport` が済ませたもの）
 * - ログ: ループの手と判断の記録を新しい順の 1 本にしたもの（`board-log.ts`）
 * - 振り返り: 集計（主な数字・グラフ・ループの手の表。`board-metrics.ts`）・マージ済み・中止
 *
 * 判断待ちのカードには、待っているゲートの最新のエントリ（提出の本文など）・PR の URL・止まりの理由を出す。
 * `repository` があれば、カードごとにデータ用ブランチのカードのファイル（GitHub）へのリンクを付ける。
 * 判断のボタンは置かない。判断は会話で頼む。
 *
 * カードのタイトルや理由は人もエージェントも書ける文字なので、すべてエスケープして埋め込み、外部のファイルを読まない。
 * スクリプトは `session` を渡されたときの更新ボタンの分だけで、決まった文をそのセッションに送るほかは何もしない。
 * 時刻は `generatedAt` だけを使い、今の時刻は読まない（純関数）。
 */
export function formatStatusHtml(report: StatusReport, options: StatusHtmlOptions = {}): string {
  const session = options.session ?? null;
  const link = cardLinker(options.repository ?? null);
  const byId = new Map(report.cards.map((card) => [card.id, card]));
  const sections = groupBySection(report.cards);
  const metrics = computeBoardMetrics(report.cards);

  const now = [
    renderSection(
      '判断待ち',
      report.waiting.length,
      report.waiting.map((summary) => renderWaiting(summary, byId.get(summary.id), link))
    ),
    renderSection(
      'AI 作業中',
      report.working.length,
      report.working.map((summary) => renderWorking(summary, byId.get(summary.id), report, link))
    ),
    renderIdeas(report, link),
  ];
  const retro = [
    renderMetrics(metrics),
    renderSection(
      'マージ済み',
      sections.merged.length,
      sections.merged.map((card) => renderMerged(card, link))
    ),
    renderSection(
      '中止',
      sections.aborted.length,
      sections.aborted.map((card) => renderAborted(card, link))
    ),
  ];

  const body = [
    renderHeader(report, session),
    renderTabs([
      { id: 'now', label: '今', count: report.waiting.length, content: now },
      { id: 'log', label: 'ログ', count: null, content: [renderLog(report, link)] },
      { id: 'retro', label: '振り返り', count: null, content: retro },
    ]),
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

interface Tab {
  readonly id: string;
  readonly label: string;
  /** タブの見出しに添える件数（今のタブの判断待ち）。null なら添えない */
  readonly count: number | null;
  readonly content: readonly string[];
}

/**
 * タブ。ラジオボタン・見出しのラベル・中身を兄弟に並べ、選ばれたラジオボタンの後ろの中身だけを CSS で出す。
 * 最初のタブを選んでおく。スクリプトは使わない
 */
function renderTabs(tabs: readonly Tab[]): string {
  const inputs = tabs.map(
    (tab, index) =>
      `<input type="radio" name="tab" class="tab-input" id="tab-${tab.id}"${index === 0 ? ' checked' : ''}>`
  );
  const labels = tabs.map((tab) => {
    const count = tab.count === null ? '' : ` <span class="count">${tab.count}</span>`;
    return `<label for="tab-${tab.id}">${escapeHtml(tab.label)}${count}</label>`;
  });
  const panels = tabs.map(
    (tab) => `<div class="tab-panel" id="panel-${tab.id}">\n${tab.content.join('\n')}\n</div>`
  );

  return `<div class="tabs">
${inputs.join('\n')}
<nav class="tab-list">${labels.join('')}</nav>
${panels.join('\n')}
</div>`;
}

function renderSection(title: string, count: number, items: readonly string[]): string {
  const content = items.length === 0 ? '<p class="empty">ありません</p>' : items.join('\n');

  return `<section>
<h2>${escapeHtml(title)} <span class="count">${count}</span></h2>
${content}
</section>`;
}

function renderWaiting(
  summary: WaitingCard,
  card: StatusCard | undefined,
  link: CardLinker
): string {
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

  return renderCard(summary, link, [
    renderRunning(summary, null),
    hold,
    renderPr(card),
    decisions,
    renderLatestReview(card),
  ]);
}

function renderWorking(
  summary: WorkingCard,
  card: StatusCard | undefined,
  report: StatusReport,
  link: CardLinker
): string {
  const tasks = card?.plan ? ` · タスク ${card.plan.tasks.completed}/${card.plan.tasks.total}` : '';
  const stale = summary.stale ? '<span class="stale">動きなし</span>' : '';
  const stuck = card === undefined ? null : describeStuck(card.loopSteps);
  const stuckMark = stuck === null ? '' : `<span class="stale">${escapeHtml(stuck)}</span>`;
  const running = runningStepOf(report.loop, summary.id);

  return renderCard(summary, link, [
    renderRunning(summary, running === null ? null : describeAction(running)),
    `<p class="reason">${escapeHtml(summary.reason)}${escapeHtml(tasks)}${stale}${stuckMark}</p>`,
    renderPr(card),
  ]);
}

/** ループが今触っているカードの印。`action` があれば今の手（`implement（task）`）を添える */
function renderRunning(summary: WaitingCard | WorkingCard, action: string | null): string {
  if (!summary.running) return '';

  const now = action === null ? '' : ` · ${escapeHtml(action)}`;
  return `<p class="running">AI 稼働中${now}</p>`;
}

function renderIdeas(report: StatusReport, link: CardLinker): string {
  const count = report.ideas.filter((row) => !('divider' in row)).length;
  if (count === 0) return renderSection('アイデア', 0, []);

  const rows = report.ideas.map((row) =>
    'divider' in row
      ? '<li class="divider">ここから下は、あとで考える</li>'
      : `<li>${link(row.id, escapeHtml(row.title))} <code>${escapeHtml(row.id)}</code></li>`
  );

  return renderSection('アイデア', count, [`<ul class="ideas">\n${rows.join('\n')}\n</ul>`]);
}

function renderMerged(card: StatusCard, link: CardLinker): string {
  const at = card.mrState?.mergedAt ?? card.plan?.updatedAt ?? null;
  const when = at === null ? '' : `<p class="reason">${escapeHtml(formatTime(at))}</p>`;

  return renderCard(card, link, [when, renderPr(card)]);
}

function renderAborted(card: StatusCard, link: CardLinker): string {
  return renderCard(card, link, []);
}

// ============================================================
// ログ
// ============================================================

/** ループの手と判断の記録を、新しい順の 1 本の時系列で出す。古いものを省いたら件数を添える */
function renderLog(report: StatusReport, link: CardLinker): string {
  const log = buildBoardLog(report.cards);
  const total = log.entries.length + log.omitted;
  if (total === 0) return renderSection('ログ', 0, []);

  const items = log.entries.map((entry) => renderLogEntry(entry, link));
  const omitted =
    log.omitted === 0
      ? ''
      : `\n<p class="empty">古い ${log.omitted} 件は省きました（新しい ${log.entries.length} 件を出しています）</p>`;

  return renderSection('ログ', total, [`<ol class="log">\n${items.join('\n')}\n</ol>${omitted}`]);
}

function renderLogEntry(entry: BoardLogEntry, link: CardLinker): string {
  const head = `<span class="log-time">${escapeHtml(formatTime(entry.at))}</span>`;
  const title = link(entry.cardId, escapeHtml(entry.cardTitle));

  if (entry.kind === 'loop') {
    const { step } = entry;
    const detail = [
      describeAction(step),
      describeResult(step),
      formatDurationMs(step.durationMs),
      `${formatTokens(step.tokens)} トークン`,
    ].join(' · ');

    return `<li class="log-loop">${head}<span class="log-kind">ループ</span>${title}<p>${escapeHtml(detail)}</p></li>`;
  }

  const { review } = entry;
  const reason =
    review.reason.trim() === ''
      ? ''
      : `\n<details><summary>理由</summary><div class="review">${escapeHtml(review.reason)}</div></details>`;

  return `<li class="log-review">${head}<span class="log-kind">判断</span>${title}<p>${escapeHtml(
    `${review.gate} ${review.kind}`
  )}</p>${reason}</li>`;
}

// ============================================================
// カード
// ============================================================

function renderCard(
  card: Pick<StatusCard, 'id' | 'title' | 'stage'>,
  link: CardLinker,
  parts: readonly string[]
): string {
  const content = parts.filter((part) => part !== '').join('\n');

  return `<article>
<h3><span class="stage">${escapeHtml(STAGE_LABELS[card.stage])}</span>${link(card.id, escapeHtml(card.title))}</h3>
<p class="id"><code>${escapeHtml(card.id)}</code></p>
${content}
</article>`;
}

/**
 * カードの詳細へのリンクを付ける関数。`html` はエスケープ済みの中身で、リポジトリが無ければそのまま返す
 */
type CardLinker = (cardId: string, html: string) => string;

function cardLinker(repository: CardRepository | null): CardLinker {
  if (repository === null) return (_cardId, html) => html;

  return (cardId, html) =>
    `<a href="${escapeHtml(cardUrl(repository, cardId))}" ${PR_LINK_ATTRIBUTES}>${html}</a>`;
}

/**
 * データ用ブランチのカードのファイルの GitHub の URL。
 * `https://github.com/<owner>/<repo>/blob/ai-board/data/cards/<id>/card.md`。各部分は URL のエスケープを通す
 */
export function cardUrl(repository: CardRepository, cardId: string): string {
  const branch = DATA_BRANCH.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(
    repository.repo
  )}/blob/${branch}/cards/${encodeURIComponent(cardId)}/card.md`;
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
 * 待っているゲートの最新のエントリ。計画レビューでは提出の本文（AI が書いた判断してほしい点）、
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
<h3 class="sub">手順書の版ごと <span class="count">.claude/HARNESS_VERSIONS.md の版。件数が少ないときは割合だけで読まない</span></h3>
${renderHarnessVersions(metrics.harnessVersions)}
</section>`;
}

/** 手順書の版ごとの表。列が版（新しい順、最後に版なし）、行が成績 */
function renderHarnessVersions(versions: readonly HarnessVersionMetrics[]): string {
  if (versions.length === 0) return '<p class="empty">まだありません</p>';

  const ratio = (part: number, whole: number): string =>
    whole === 0 ? '—' : `${Math.round((part / whole) * 100)}%（${part}/${whole}）`;

  const rows: readonly (readonly [string, (entry: HarnessVersionMetrics) => string])[] = [
    ['1 手の数', (entry) => `${entry.stepCount}`],
    ['1 手の時間（中央値）', (entry) => durationOrDash(entry.durationMedianMs)],
    [
      '1 手のトークン（中央値）',
      (entry) =>
        entry.tokensMedian === null
          ? '—'
          : `${countOrDash(entry.tokensMedian)}（${entry.tokensCount} 件）`,
    ],
    ['止まった割合', (entry) => ratio(entry.stuckCount, entry.finishedCount)],
    ['やり直し', (entry) => `${entry.retryCount} 回`],
    ['否決率', (entry) => ratio(entry.rejectedCardCount, entry.cardCount)],
    ['否決の延べ回数', (entry) => `${entry.rejectionCount} 回`],
    [
      '人を待った時間（中央値）',
      (entry) =>
        entry.humanWaitMedianMs === null
          ? '—'
          : `${formatDuration(entry.humanWaitMedianMs)}（${entry.humanWaitCardCount} 枚）`,
    ],
  ];

  const head = versions
    .map((entry) => `<th scope="col">${escapeHtml(entry.harness ?? '版なし')}</th>`)
    .join('');
  const body = rows.map(
    ([label, cell]) =>
      `<tr><th scope="row">${escapeHtml(label)}</th>${versions
        .map((entry) => `<td>${escapeHtml(cell(entry))}</td>`)
        .join('')}</tr>`
  );

  return `<div class="table-wrap"><table class="loop harness">
<thead><tr><th scope="col">成績</th>${head}</tr></thead>
<tbody>
${body.join('\n')}
</tbody>
</table></div>`;
}

function renderStats(metrics: BoardMetrics): string {
  const { summary } = metrics;
  const duration = durationOrDash;
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
    const duration = durationOrDash(entry.avgDurationMs);
    const tokens = countOrDash(entry.avgTokens);

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

/** 時間。値が無ければ「—」 */
function durationOrDash(ms: number | null): string {
  return ms === null ? '—' : formatDuration(ms);
}

/** トークンなどの数を 3 桁区切りで。値が無ければ「—」 */
function countOrDash(value: number | null): string {
  return value === null ? '—' : Math.round(value).toLocaleString('en-US');
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
 * PR とカードの詳細のリンクの属性。Artifact の中では `target="_blank"` が開かなかったので、外側の窓で開く `_top` にする。
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
.tab-input { position: absolute; opacity: 0; pointer-events: none; }
.tab-list { display: flex; gap: 4px; margin: 16px 0 0; border-bottom: 1px solid var(--border); overflow-x: auto; }
.tab-list label {
  padding: 6px 14px; cursor: pointer; color: var(--muted); border-bottom: 2px solid transparent;
  margin-bottom: -1px; white-space: nowrap;
}
#tab-now:checked ~ .tab-list label[for="tab-now"],
#tab-log:checked ~ .tab-list label[for="tab-log"],
#tab-retro:checked ~ .tab-list label[for="tab-retro"] { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
#tab-now:focus-visible ~ .tab-list label[for="tab-now"],
#tab-log:focus-visible ~ .tab-list label[for="tab-log"],
#tab-retro:focus-visible ~ .tab-list label[for="tab-retro"] { outline: 2px solid var(--accent); outline-offset: -2px; }
.tab-panel { display: none; }
#tab-now:checked ~ #panel-now,
#tab-log:checked ~ #panel-log,
#tab-retro:checked ~ #panel-retro { display: block; }
.log { list-style: none; padding: 0; margin: 0; }
.log li { border-bottom: 1px solid var(--border); padding: 6px 0; overflow-wrap: anywhere; }
.log li p { margin: 2px 0 0; font-size: 0.9rem; }
.log-time { color: var(--muted); font-size: 0.8rem; margin-right: 8px; }
.log-kind {
  display: inline-block; font-size: 0.75rem; background: var(--stage-bg); border-radius: 4px;
  padding: 0 6px; margin-right: 8px;
}
.log-review .log-kind { color: var(--warn); background: var(--warn-bg); }
`;
