import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { err, isErr, ok, type Result } from '../../shared/result.js';
import type { CardId } from '../../shared/schemas/common.js';
import {
  checkDataBranchAbsent,
  createDataBranch,
  type CreateDataBranchOptions,
  type DataBranchCreateError,
} from '../../infrastructure/data-store.js';
import type { LegacyBoard, LegacyDatabaseError } from '../../infrastructure/database.js';
import type { MrSnapshot } from '../../board/models/mr-state.js';
import {
  SNAPSHOTS_DIR,
  serializeMergedSnapshot,
  snapshotFileName,
} from '../../board/repositories/file-mr-snapshot.repository.js';
import type { Card } from '../models/card.js';
import type { ReviewEntry } from '../models/review.js';
import { parseReviewLog } from '../services/review-log.js';
import {
  CARDS_DIR,
  CARD_FILE,
  DATA_VERSION_FILE,
  LOG_DIR,
  ORDER_FILE,
  demoteHeadings,
  legacyCardFiles,
  serializeDataVersion,
  serializeOrder,
  stripReviewSection,
  type CardWriteError,
} from '../repositories/card-files.js';
import { FileCardRepository } from '../repositories/file-card.repository.js';
import { FileIdeaDividerRepository } from '../repositories/file-idea-divider.repository.js';
import { describeDataStoreError } from './data-store-messages.js';

// ============================================================
// ai-board migrate — 移行前の board.db をデータ用ブランチへ書き出す
// ============================================================

export const MIGRATE_USAGE = `使い方: ai-board migrate [--from <db>] [--empty] [--root <path>]

移行前の board.db のカードを、データ用ブランチ（origin の ai-board/data）へ書き出して push します。
切り替えのときに 1 回だけ走らせます。データ用ブランチが既にあれば、何もせずに止まります。

Options:
  --from <db>   読む board.db（既定: .ai-board/board.db）
  --empty       board.db を読まずに、空のデータ用ブランチを作る
  -h, --help    このヘルプを表示
`;

/** データ用ブランチの根の設定ファイル。移行前の `.ai-board/config.yaml` を写す */
const CONFIG_FILE = 'config.yaml';

export interface MigrateCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface MigrateCliDependencies {
  /** データ用ブランチを作る場所 */
  readonly target: CreateDataBranchOptions;
  /** `--from` を省いたときに読む DB（`.ai-board/board.db`） */
  readonly defaultFrom: string;
  /** データ用ブランチの根に写す、移行前の `config.yaml`。無ければ写さない */
  readonly configFile: string;
  /** 移行前の DB を読む（`readLegacyBoard`）。`node:sqlite` をこのモジュールで読み込まないよう、呼び出し側から渡す */
  readonly readLegacy: (dbPath: string) => Result<LegacyBoard, LegacyDatabaseError>;
}

interface MigrateArgs {
  readonly from: string | null;
  readonly empty: boolean;
}

/** カードをファイルにできなかった（時刻がファイル名にできないなど） */
interface CardFilesRefused {
  readonly type: 'CardFilesRefused';
  readonly id: CardId;
  readonly reason: CardWriteError['type'];
}

/** 一時ディレクトリに書いて読み戻したカードが、DB のカードと一致しなかった */
interface MigrationMismatch {
  readonly type: 'MigrationMismatch';
  readonly from: string;
  readonly mismatches: readonly string[];
}

type MigrateError =
  DataBranchCreateError | LegacyDatabaseError | CardFilesRefused | MigrationMismatch;

/** データ用ブランチに書く準備ができたもの */
interface PreparedMigration {
  readonly legacy: LegacyBoard;
  readonly files: ReadonlyMap<string, string>;
}

const EMPTY_BOARD: LegacyBoard = { cards: [], divider: null, mrSnapshots: new Map() };

/**
 * `ai-board migrate` を実行し、終了コードを返す。
 *
 * 1. データ用ブランチが `origin` にも手元にも無いことを確かめる（あれば何もせずに止まる）
 * 2. DB を読み、データ用ブランチのファイルを組み立てる
 * 3. 一時ディレクトリに書いて読み戻し、DB のカードと一致するかを確かめる（食い違えば git に触らずに止まる）
 * 4. データ用ブランチを作り、1 コミットにして push する
 */
export async function runMigrateCli(
  argv: readonly string[],
  deps: MigrateCliDependencies,
  io: MigrateCliIo
): Promise<number> {
  const args = parseMigrateArgs(argv);
  if (typeof args === 'string') {
    io.stderr(args === 'help' ? MIGRATE_USAGE : `${args}\n${MIGRATE_USAGE}`);
    return args === 'help' ? 0 : 1;
  }

  const fail = (error: MigrateError): number => {
    io.stderr(`${describeMigrateError(error, deps.target)}\n`);
    return 1;
  };

  const absent = await checkDataBranchAbsent(deps.target);
  if (isErr(absent)) return fail(absent.error);

  const from = args.from ?? deps.defaultFrom;
  const prepared = await prepareMigration(args.empty ? null : from, deps);
  if (isErr(prepared)) return fail(prepared.error);
  const { legacy, files } = prepared.value;

  const created = await createDataBranch(
    deps.target,
    args.empty ? 'data: 空のデータ用ブランチを作る' : 'data: board.db から移す',
    (dataDir) => writeDataFiles(dataDir, files)
  );
  if (isErr(created)) return fail(created.error);

  io.stdout(describeMigrated(args.empty ? null : from, legacy, deps, created.value.pushed));
  return 0;
}

/**
 * DB を読み（`from` が null なら空のボード）、データ用ブランチのファイルを組み立て、一時ディレクトリで確かめる。
 * git には触らない。
 */
async function prepareMigration(
  from: string | null,
  deps: MigrateCliDependencies
): Promise<Result<PreparedMigration, MigrateError>> {
  const legacy = from === null ? ok<LegacyBoard>(EMPTY_BOARD) : deps.readLegacy(from);
  if (isErr(legacy)) return legacy;

  const files = buildDataFiles(legacy.value, readFileOrNull(deps.configFile));
  if (isErr(files)) return files;

  const mismatches = await verifyDataFiles(files.value, legacy.value);
  if (mismatches.length > 0) {
    return err({ type: 'MigrationMismatch', from: from ?? '', mismatches });
  }

  return ok({ legacy: legacy.value, files: files.value });
}

/** 書き出した結果の 2 行。`from` が null なら空のデータ用ブランチを作った */
function describeMigrated(
  from: string | null,
  legacy: LegacyBoard,
  deps: MigrateCliDependencies,
  pushed: boolean
): string {
  const dataDir = path.resolve(deps.target.dataDir);
  const written =
    from === null
      ? `空のデータ用ブランチを作りました（${dataDir}）`
      : `${legacy.cards.length} 枚のカードをデータ用ブランチに書き出しました（${from} → ${dataDir}）`;
  const sent = pushed
    ? 'origin の ai-board/data へ push しました'
    : 'origin が無いため、push せずにコミットだけしました';

  return `${written}\n${sent}\n`;
}

function parseMigrateArgs(argv: readonly string[]): MigrateArgs | 'help' | string {
  let from: string | null = null;
  let empty = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case '-h':
      case '--help':
        return 'help';
      case '--empty':
        empty = true;
        break;
      case '--from': {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) return '--from には値を指定してください';
        from = path.resolve(value);
        i += 1;
        break;
      }
      default:
        return `不明な引数です: ${String(arg)}`;
    }
  }

  if (empty && from !== null) return '--from と --empty は一緒に指定できません';
  return { from, empty };
}

// ============================================================
// データ用ブランチのファイルの組み立て
// ============================================================

/**
 * データ用ブランチに置くファイルを、データ用ブランチの根からの相対パス（`/` 区切り）と中身の組で返す。
 *
 * カードは `legacyCardFiles` で `card.md` と判断のファイルに分ける。rank と区切り線は `order.yaml` に、
 * マージ済みの PR の控えは `snapshots/` に置く（開いている PR の控えは使い捨てなので移さない）。
 */
export function buildDataFiles(
  legacy: LegacyBoard,
  config: string | null
): Result<Map<string, string>, CardFilesRefused> {
  const files = new Map<string, string>();
  files.set(DATA_VERSION_FILE, serializeDataVersion());

  const ranks: Record<string, number> = {};
  for (const card of legacy.cards) {
    if (card.rank !== null) ranks[card.id] = card.rank;
  }
  files.set(ORDER_FILE, serializeOrder({ divider: legacy.divider, ranks }));

  if (config !== null) files.set(CONFIG_FILE, config);

  for (const card of legacy.cards) {
    const cardFiles = legacyCardFiles(card);
    if (isErr(cardFiles)) {
      return err({ type: 'CardFilesRefused', id: card.id, reason: cardFiles.error.type });
    }

    const dir = `${CARDS_DIR}/${card.id}`;
    files.set(`${dir}/${CARD_FILE}`, cardFiles.value.cardMd);
    for (const log of cardFiles.value.log) {
      files.set(`${dir}/${LOG_DIR}/${log.name}`, log.content);
    }
  }

  for (const [cardId, snapshot] of mergedSnapshots(legacy.mrSnapshots)) {
    files.set(`${SNAPSHOTS_DIR}/${snapshotFileName(cardId)}`, serializeMergedSnapshot(snapshot));
  }

  return ok(files);
}

function mergedSnapshots(
  snapshots: ReadonlyMap<CardId, MrSnapshot>
): (readonly [CardId, MrSnapshot])[] {
  return [...snapshots].filter(([, snapshot]) => snapshot.mr.state === 'merged');
}

/** `buildDataFiles` のファイルを `dir` の下に書く */
export function writeDataFiles(dir: string, files: ReadonlyMap<string, string>): void {
  for (const [relative, content] of files) {
    const target = path.join(dir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

// ============================================================
// 書き出したカードと DB のカードの照らし合わせ
// ============================================================

/**
 * ファイルを一時ディレクトリに書いて、カードと区切り線を読み戻し、DB と照らし合わせる。食い違いの文を返す。
 *
 * git に触る前に確かめるので、食い違っても片付けるものが無い。
 */
async function verifyDataFiles(
  files: ReadonlyMap<string, string>,
  legacy: LegacyBoard
): Promise<string[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-board-migrate-'));

  try {
    writeDataFiles(dir, files);
    const cards = await new FileCardRepository(dir).findAll();
    const divider = await new FileIdeaDividerRepository(dir).get();

    const mismatches = compareMigratedCards(legacy.cards, cards);
    if (divider !== legacy.divider) {
      mismatches.push(`区切り線: ${String(legacy.divider)} が ${String(divider)} になりました`);
    }
    return mismatches;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * DB のカード（`expected`）と、書き出したファイルから組み立て直したカード（`actual`）を照らし合わせる。
 *
 * 本文はそのまま比べない。組み立て直すと `## レビュー` は最後の節へ動き、理由の中の見出しは `####` へ下がる。
 * 代わりに次の 3 つを比べる。
 *
 * - frontmatter の項目（`startedAt` と `rank` を含む）。時刻は同じ瞬間かで比べる（ファイル名はミリ秒までの形に揃う）
 * - `parseReviewLog` のエントリ。並びも比べる（同じ時刻の判断は、並びの後ろのものが効く）。理由は DB の側の見出しを下げて比べる
 * - `## レビュー` の節を除いた本文
 */
export function compareMigratedCards(expected: readonly Card[], actual: readonly Card[]): string[] {
  const actualById = new Map(actual.map((card) => [card.id, card]));
  const expectedIds = new Set(expected.map((card) => card.id));
  const mismatches: string[] = [];

  for (const card of expected) {
    const written = actualById.get(card.id);
    if (written === undefined) {
      mismatches.push(`${card.id}: 書き出したカードが読めません`);
      continue;
    }

    const fields = differingFields(card, written);
    if (fields.length > 0) mismatches.push(`${card.id}: ${fields.join('、')} が一致しません`);
  }

  for (const card of actual) {
    if (!expectedIds.has(card.id)) mismatches.push(`${card.id}: DB に無いカードが書き出されました`);
  }

  return mismatches;
}

function differingFields(expected: Card, actual: Card): string[] {
  const checks: readonly (readonly [string, boolean])[] = [
    ['title', expected.title === actual.title],
    ['created', sameInstant(expected.created, actual.created)],
    ['startedAt', sameInstant(expected.startedAt, actual.startedAt)],
    ['skipGates', isDeepStrictEqual(expected.skipGates, actual.skipGates)],
    ['branch', expected.branch === actual.branch],
    ['mr', expected.mr === actual.mr],
    ['rank', expected.rank === actual.rank],
    ['## レビュー のエントリ', sameEntries(expected.body, actual.body)],
    ['本文', stripReviewSection(expected.body) === stripReviewSection(actual.body)],
  ];

  return checks.filter(([, same]) => !same).map(([name]) => name);
}

function sameEntries(expectedBody: string, actualBody: string): boolean {
  const expected = parseReviewLog(expectedBody);
  const actual = parseReviewLog(actualBody);

  return (
    expected.length === actual.length &&
    expected.every((entry, index) => sameEntry(entry, actual[index]))
  );
}

function sameEntry(expected: ReviewEntry, actual: ReviewEntry | undefined): boolean {
  return (
    actual !== undefined &&
    sameInstant(expected.at, actual.at) &&
    expected.gate === actual.gate &&
    expected.kind === actual.kind &&
    demoteHeadings(expected.reason) === actual.reason
  );
}

// ============================================================
// ヘルパー
// ============================================================

function describeMigrateError(error: MigrateError, target: CreateDataBranchOptions): string {
  switch (error.type) {
    case 'LegacyDatabaseMissing':
      return (
        `${error.dbPath} がありません。--from で board.db の場所を指定するか、` +
        '空のデータ用ブランチを作るなら --empty を付けてください'
      );
    case 'LegacyDatabaseUnreadable':
      return `${error.dbPath} を読めません: ${error.reason}`;
    case 'CardFilesRefused':
      return `${error.id} をデータ用ブランチのファイルにできません（${error.reason}）`;
    case 'MigrationMismatch':
      return (
        `書き出したカードが DB と一致しないため、データ用ブランチを作らずに止まりました（${error.from}）\n` +
        error.mismatches.map((line) => `  ${line}`).join('\n')
      );
    default:
      return describeBranchError(error, target);
  }
}

function describeBranchError(
  error: DataBranchCreateError,
  target: CreateDataBranchOptions
): string {
  switch (error.type) {
    case 'DataBranchExists':
      return error.where === 'origin'
        ? 'データ用ブランチ（origin の ai-board/data）が既にあります。何もせずに止まりました'
        : '手元に ai-board/data のブランチが既にあります（origin にはありません）。' +
            '中身を確かめ、要らなければ git branch -D ai-board/data で消してからやり直してください';
    case 'DataDirNotEmpty':
      return `${error.dataDir} に既にファイルがあります。中身を確かめ、要らなければ消してからやり直してください`;
    case 'DataDirNotRepository':
      return target.repoRoot === undefined
        ? `${error.dataDir} は git の clone ではありません。AI_BOARD_DATA には、origin を持つ空の clone を指してください`
        : describeDataStoreError(error, null);
    case 'DataStoreFetchFailed':
      return `origin に問い合わせられないため、データ用ブランチの有無を確かめられません（${error.message}）`;
    default:
      return describeDataStoreError(error, null);
  }
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;

  return Date.parse(a) === Date.parse(b);
}

function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
