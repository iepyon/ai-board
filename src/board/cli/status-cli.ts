import type { CardCliIo } from '../../cards/cli/card-cli.js';
import { groupBySection, isStale } from '../../shared/dashboard-sections.js';
import { STAGE_LABELS } from '../../shared/stage-labels.js';
import type { Stage } from '../../shared/schemas/common.js';
import type { GetBoardQuery } from '../usecases/queries/get-board.query.js';
import type { Board, BoardCard } from '../models/board-card.js';
import type { ForgeConnection } from '../models/mr-state.js';
import { pickNextAction, type NextAction } from '../services/next-action.js';

// ============================================================
// ai-board status — サーバを起動せずにボードの状態を読む
// ============================================================

export const STATUS_USAGE = `使い方: ai-board status [--json] [--root <path>]

ボードの状態（導出したステージ、判断待ち、次の一手）を出します。サーバは要りません。
  --json   機械向けの JSON で出す（AI ループはこちらを読む）
`;

/**
 * 人の番のカード。判断を待つ列（計画レビュー / 動作確認 / PR中）のカードと、
 * AI の列で止まっているカード（`hold`。ループはこれを選ばない）
 */
export interface WaitingCard {
  readonly id: string;
  readonly title: string;
  readonly stage: Stage;
  readonly reason: string;
}

export type StatusCard = Omit<BoardCard, 'body'>;

/** AI が進めているカード。`stale` はしばらく動きが無いもの */
export interface WorkingCard extends WaitingCard {
  readonly stale: boolean;
}

export interface StatusReport {
  /** ループが次に進めるもの。無いか、GitHub につながっていなければ null */
  readonly next: NextAction | null;
  readonly waiting: readonly WaitingCard[];
  readonly working: readonly WorkingCard[];
  readonly cards: readonly StatusCard[];
  readonly forge: ForgeConnection;
  readonly generatedAt: string;
}

export interface StatusDependencies {
  readonly getBoardQuery: GetBoardQuery;
}

export type StatusArgs = { readonly json: boolean } | 'help' | 'invalid';

/**
 * 引数を解釈する。DB を開いたり GitHub に問い合わせたりする前に呼ぶ
 * （`--help` や打ち間違いで PR 番号の書き戻しを起こさないため）。
 */
export function parseStatusArgs(argv: readonly string[]): StatusArgs {
  if (argv.includes('--help') || argv.includes('-h')) return 'help';
  if (argv.some((arg) => arg !== '--json')) return 'invalid';

  return { json: argv.includes('--json') };
}

/** `ai-board status` を実行し、終了コードを返す */
export async function runStatusCli(
  argv: readonly string[],
  deps: StatusDependencies,
  io: Pick<CardCliIo, 'stdout' | 'stderr' | 'now'>
): Promise<number> {
  const args = parseStatusArgs(argv);
  if (typeof args === 'string') {
    io.stderr(STATUS_USAGE);
    return args === 'help' ? 0 : 1;
  }

  const result = await deps.getBoardQuery();
  if (!result.ok) {
    io.stderr(`ボードを読めませんでした: ${result.error.reason}\n`);
    return 1;
  }

  const report = buildStatusReport(result.value, io.now());

  io.stdout(args.json ? `${JSON.stringify(report, null, 2)}\n` : formatStatus(report));
  return 0;
}

/**
 * ボードから、ループと人が読むための要約を組み立てる。
 *
 * GitHub につながっていないときは次の一手を出さない。PR の状態が引けないと、
 * 計画レビュー / PR中 のカードが手前の AI の列に落ちて見え、人を待つカードを進めてしまうため。
 * `github:` の無いリポジトリでも同じで、ループは `gh` で PR を出すので GitHub を前提にする。
 */
export function buildStatusReport(board: Board, now: Date): StatusReport {
  const cards = board.cards.map(({ body: _body, ...rest }) => rest);
  // 画面の判断待ちの区画と同じ振り分け。止まっているカードは inbox に入り、work には入らない
  const sections = groupBySection(cards);

  return {
    next: board.forge.status === 'connected' ? pickNextAction(cards) : null,
    waiting: sections.inbox.map(toWaiting),
    working: sections.work.map((card) => ({ ...toWaiting(card), stale: isStale(card, now) })),
    cards,
    forge: board.forge,
    generatedAt: board.generatedAt,
  };
}

/** 人向けの数行。判断待ち / AI 作業中 / 次の一手 の順に並べる */
export function formatStatus(report: StatusReport): string {
  const lines = [`GitHub: ${describeForge(report.forge)}`, ''];

  lines.push(`判断待ち (${report.waiting.length})`);
  for (const card of report.waiting) {
    lines.push(`  ${card.id}  [${STAGE_LABELS[card.stage]}]  ${card.title}`);
    lines.push(`    ${card.reason}`);
  }

  lines.push('', `AI 作業中 (${report.working.length})`);
  for (const card of report.working) {
    const stale = card.stale ? '  ※ 動きなし' : '';
    lines.push(`  ${card.id}  [${STAGE_LABELS[card.stage]}]  ${card.title}${stale}`);
  }

  lines.push('', `次の一手: ${describeNext(report)}`);

  return `${lines.join('\n')}\n`;
}

/** 止まっているカードは、ステージの理由ではなく人が何をすればよいか（`hold.reason`）を出す */
function toWaiting(card: StatusCard): WaitingCard {
  return {
    id: card.id,
    title: card.title,
    stage: card.stage,
    reason: card.hold?.reason ?? card.reason,
  };
}

function describeNext({ next, forge }: StatusReport): string {
  if (next !== null) return `${next.action} ${next.cardId}（${next.reason}）`;

  return forge.status === 'connected'
    ? 'なし（AI が進められるカードはありません）'
    : 'なし（GitHub に接続できないため、ループは止まります）';
}

function describeForge(forge: ForgeConnection): string {
  switch (forge.status) {
    case 'connected':
      return '接続済み';
    case 'error':
      return `エラー（${forge.message}）`;
    case 'disabled':
      return forge.reason === null ? '未設定' : `使えません（${forge.reason}）`;
  }
}
