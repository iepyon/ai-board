import type { CardCliIo } from '../../cards/cli/card-cli.js';
import { STAGE_LABELS } from '../../shared/stage-labels.js';
import type { StatusReport, CardSummary } from '../models/status-report.js';
import type { GetStatusQuery } from '../usecases/queries/get-status.query.js';
import { describeForge, describeLoop, describeNext, describeStuck } from './status-describe.js';

// ============================================================
// ai-board status — ボードの状態を読む
// ============================================================

/**
 * `StatusReport` の最上位の項目と、配列かどうか。`--only` の打ち間違いを、出す前に見分けるのに使う。
 * `satisfies` で `StatusReport` の項目と食い違えば型検査で落ちる
 */
const STATUS_KEY_KINDS = {
  next: 'value',
  waiting: 'array',
  working: 'array',
  cards: 'array',
  ideas: 'array',
  forge: 'value',
  loop: 'value',
  generatedAt: 'value',
} as const satisfies Record<keyof StatusReport, 'value' | 'array'>;

const STATUS_KEYS = Object.keys(STATUS_KEY_KINDS) as (keyof StatusReport)[];

function isStatusKey(key: string): key is keyof StatusReport {
  return Object.hasOwn(STATUS_KEY_KINDS, key);
}

export const STATUS_USAGE = `使い方: ai-board status [--json [--only <項目,...>]] [--root <path>]

ボードの状態（導出したステージ、判断待ち、次の一手）を出します。
  --json   機械向けの JSON で出す（AI ループはこちらを読む）
  --only <項目,...>
           --json の出力を、コンマ区切りの項目だけに絞る。項目は <key>（最上位の項目）か
           <key>.<field>（最上位の配列の各要素から <field> だけ）。例: --only next,waiting,cards.id
           最上位の項目: ${STATUS_KEYS.join(', ')}
`;

export interface StatusDependencies {
  /** ボードの見せる形を組む（判断待ち・作業中・アイデアの表・次の一手。`next.step` もここで埋まる） */
  readonly getStatusQuery: GetStatusQuery;
}

/** 出す形。`text` は人向けの数行 */
export type StatusFormat = 'text' | 'json';

export type StatusArgs =
  | {
      readonly format: StatusFormat;
      readonly only?: readonly StatusField[];
    }
  | 'help'
  | 'invalid';

/**
 * `--only` の 1 項目。`field` が null なら最上位の項目をそのまま出し、
 * 文字列なら最上位の配列の各要素から `field` だけを出す
 */
export interface StatusField {
  readonly key: keyof StatusReport;
  readonly field: string | null;
}

/**
 * 引数を解釈する。DB を開いたり GitHub に問い合わせたりする前に呼ぶ
 * （`--help` や打ち間違いで PR 番号の書き戻しを起こさないため）。
 */
export function parseStatusArgs(argv: readonly string[]): StatusArgs {
  if (argv.includes('--help') || argv.includes('-h')) return 'help';

  const scanned = scanStatusArgs(argv);
  if (scanned === null) return 'invalid';

  const format = pickFormat(scanned);
  if (format === null) return 'invalid';

  const { only } = scanned;
  return { format, ...(only === null ? {} : { only }) };
}

/** 出す形を決める。絞り込みは JSON にだけ効く。組み合わせが誤っていれば null */
function pickFormat({ json, only }: ScannedStatusArgs): StatusFormat | null {
  if (only !== null && !json) return null;

  return json ? 'json' : 'text';
}

interface ScannedStatusArgs {
  json: boolean;
  only: readonly StatusField[] | null;
}

/** 引数を 1 つずつ読む。不明な引数や、2 回目の `--only`、`--only` の値の誤りは null */
function scanStatusArgs(argv: readonly string[]): ScannedStatusArgs | null {
  const scanned: ScannedStatusArgs = { json: false, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') scanned.json = true;
    else if (arg === '--only' && scanned.only === null) {
      scanned.only = parseOnly(argv[++i]);
      if (scanned.only === null) return null;
    } else return null;
  }
  return scanned;
}

/**
 * `--only` の値を解釈する。誤り（値が無い、無い最上位の項目、配列でない項目への `.`、2 段以上の `.`）は null。
 * 打ち間違いを黙って空の出力にしないため、出す前に失敗させる
 */
function parseOnly(value: string | undefined): readonly StatusField[] | null {
  if (value === undefined || value.startsWith('--')) return null;

  const fields: StatusField[] = [];
  for (const item of value.split(',')) {
    const [key, field, ...deeper] = item.split('.');
    if (key === undefined || !isStatusKey(key) || deeper.length > 0) return null;
    if (field === undefined) {
      fields.push({ key, field: null });
      continue;
    }
    if (field === '' || STATUS_KEY_KINDS[key] !== 'array') return null;
    fields.push({ key, field });
  }
  return fields;
}

/**
 * 出力を `fields` の項目だけに絞る。最上位の項目は `fields` に初めて出た順に並べる。
 *
 * 同じ最上位の項目を丸ごとと `.<field>` の両方で指したら、丸ごと出す。
 * 要素に無い `<field>` は、その要素では出さない（カードによって無い項目があるため）。
 */
export function pickFields(
  report: StatusReport,
  fields: readonly StatusField[]
): Record<string, unknown> {
  const wanted = new Map<keyof StatusReport, Set<string> | 'whole'>();
  for (const { key, field } of fields) {
    const current = wanted.get(key);
    if (field === null || current === 'whole') {
      wanted.set(key, 'whole');
    } else {
      wanted.set(key, (current ?? new Set<string>()).add(field));
    }
  }

  const picked: Record<string, unknown> = {};
  for (const [key, want] of wanted) {
    const value = report[key];
    picked[key] =
      want === 'whole' || !Array.isArray(value)
        ? value
        : value.map((element: object) =>
            Object.fromEntries(Object.entries(element).filter(([name]) => want.has(name)))
          );
  }
  return picked;
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

  const result = await deps.getStatusQuery(io.now());
  if (!result.ok) {
    io.stderr(`ボードを読めませんでした: ${result.error.reason}\n`);
    return 1;
  }
  const report = result.value;

  io.stdout(
    args.only === undefined
      ? formatReport(report, args.format)
      : `${JSON.stringify(pickFields(report, args.only), null, 2)}\n`
  );
  return 0;
}

function formatReport(report: StatusReport, format: StatusFormat): string {
  switch (format) {
    case 'json':
      return `${JSON.stringify(report, null, 2)}\n`;
    case 'text':
      return formatStatus(report);
  }
}

/** 人向けの数行。判断待ち / AI 作業中 / 次の一手 の順に並べる */
export function formatStatus(report: StatusReport): string {
  const lines = [`GitHub: ${describeForge(report.forge)}`, describeLoop(report), ''];

  lines.push(`判断待ち (${report.waiting.length})`);
  for (const card of report.waiting) {
    lines.push(`  ${card.id}  [${STAGE_LABELS[card.stage]}]  ${card.title}${runningMark(card)}`);
    lines.push(`    ${card.reason}`);
  }

  lines.push('', `AI 作業中 (${report.working.length})`);
  for (const card of report.working) {
    const stale = card.stale ? '  ※ 動きなし' : '';
    lines.push(
      `  ${card.id}  [${STAGE_LABELS[card.stage]}]  ${card.title}${runningMark(card)}${stale}`
    );
  }

  const nextCard = report.cards.find((card) => card.id === report.next?.cardId);
  const stuck = nextCard === undefined ? null : describeStuck(nextCard.loopSteps);
  lines.push(
    '',
    `次の一手: ${describeNext(report.next, report.forge)}${stuck === null ? '' : `  ※ ${stuck}`}`
  );

  return `${lines.join('\n')}\n`;
}

function runningMark(card: CardSummary): string {
  return card.running ? '  ※ AI 稼働中' : '';
}
