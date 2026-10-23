import type { CardCliIo } from '../../cards/cli/card-cli.js';
import { groupBySection, isStale } from '../../shared/dashboard-sections.js';
import { STAGE_LABELS } from '../../shared/stage-labels.js';
import type { Stage } from '../../shared/schemas/common.js';
import type { GetBoardQuery } from '../usecases/queries/get-board.query.js';
import type { Board, BoardCard } from '../models/board-card.js';
import type { ForgeConnection } from '../models/mr-state.js';
import { findStuckCards, pickNextAction, type NextAction } from '../services/next-action.js';

// ============================================================
// ai-board status — サーバを起動せずにボードの状態を読む
// ============================================================

export const STATUS_USAGE = `使い方: ai-board status [--json] [--root <path>]

ボードの状態（導出したステージ、判断待ち、次の一手）を出します。サーバは要りません。
  --json   機械向けの JSON で出す（AI ループはこちらを読む）
`;

/** 人の番か、ループが推測で手を出さないカード */
export interface WaitingCard {
  readonly id: string;
  readonly title: string;
  readonly stage: Stage;
  readonly reason: string;
}

export type StatusCard = Omit<BoardCard, 'body'>;

export interface StatusReport {
  /** ループが次に進めるもの。無ければ null */
  readonly next: NextAction | null;
  readonly waiting: readonly WaitingCard[];
  readonly cards: readonly StatusCard[];
  readonly forge: ForgeConnection;
  readonly generatedAt: string;
}

export interface StatusDependencies {
  readonly getBoardQuery: GetBoardQuery;
}

/** `ai-board status` を実行し、終了コードを返す */
export async function runStatusCli(
  argv: readonly string[],
  deps: StatusDependencies,
  io: Pick<CardCliIo, 'stdout' | 'stderr' | 'now'>
): Promise<number> {
  const unknown = argv.find((arg) => arg !== '--json');
  if (unknown !== undefined) {
    io.stderr(STATUS_USAGE);
    return unknown === '--help' || unknown === '-h' ? 0 : 1;
  }

  const result = await deps.getBoardQuery();
  if (!result.ok) {
    io.stderr(`ボードを読めませんでした: ${result.error.reason}\n`);
    return 1;
  }

  const report = buildStatusReport(result.value);

  io.stdout(
    argv.includes('--json')
      ? `${JSON.stringify(report, null, 2)}\n`
      : formatStatus(report, result.value.cards, io.now())
  );
  return 0;
}

/** ボードから、ループと人が読むための要約を組み立てる */
export function buildStatusReport(board: Board): StatusReport {
  const byId = new Map(board.cards.map((card) => [card.id, card]));

  const inbox = groupBySection(board.cards).inbox.map(toWaiting);
  const stuck = findStuckCards(board.cards).flatMap(({ cardId, reason }) => {
    const card = byId.get(cardId);
    return card === undefined ? [] : [{ ...toWaiting(card), reason }];
  });

  return {
    next: pickNextAction(board.cards),
    waiting: [...inbox, ...stuck],
    cards: board.cards.map(({ body: _body, ...rest }) => rest),
    forge: board.forge,
    generatedAt: board.generatedAt,
  };
}

/** 人向けの数行。判断待ち / AI 作業中 / 次の一手 の順に並べる */
export function formatStatus(report: StatusReport, cards: readonly BoardCard[], now: Date): string {
  const work = groupBySection(cards).work;
  const lines = [`GitHub: ${describeForge(report.forge)}`, ''];

  lines.push(`判断待ち (${report.waiting.length})`);
  for (const card of report.waiting) {
    lines.push(`  ${card.id}  [${STAGE_LABELS[card.stage]}]  ${card.title}`);
    lines.push(`    ${card.reason}`);
  }

  lines.push('', `AI 作業中 (${work.length})`);
  for (const card of work) {
    const stale = isStale(card, now) ? '  ※ 動きなし' : '';
    lines.push(`  ${card.id}  [${STAGE_LABELS[card.stage]}]  ${card.title}${stale}`);
  }

  lines.push('', `次の一手: ${describeNext(report.next)}`);

  return `${lines.join('\n')}\n`;
}

function toWaiting(card: BoardCard): WaitingCard {
  return { id: card.id, title: card.title, stage: card.stage, reason: card.reason };
}

function describeNext(next: NextAction | null): string {
  return next === null
    ? 'なし（AI が進められるカードはありません）'
    : `${next.action} ${next.cardId}（${next.reason}）`;
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
