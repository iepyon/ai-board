import { isDeepStrictEqual } from 'node:util';
import matter from 'gray-matter';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { ok, err, type Result } from '../../shared/result.js';
import { CardIdSchema, type CardId, type MergeRequestIid } from '../../shared/schemas/common.js';
import { CardFrontmatterSchema } from '../models/schemas/card.schema.js';
import type { Card } from '../models/card.js';
import type { ReviewEntry, ReviewGate, ReviewKind } from '../models/review.js';
import {
  appendReviewEntry,
  hasReviewSection,
  parseReviewLog,
  stripReviewSection,
} from '../services/review-log.js';

// ============================================================
// データ用ブランチのファイルの形 — 純関数のみ。I/O は持たない
// ============================================================

/**
 * データ用ブランチ（`ai-board/data`）の中身は次のとおり。
 *
 * ```
 * ai-board-data.yaml                      形の版（version: 1）
 * order.yaml                              rank とアイデアの区切り線
 * cards/<id>/card.md                      frontmatter（id, title, created, skipGates, branch, mr）と本文
 * cards/<id>/log/<時刻>.<gate>.<種別>.md   判断 1 件。中身は理由の本文
 * snapshots/<id>.json                    マージ済みの PR の控え（file-mr-snapshot.repository.ts）
 * loop/<時刻>.<ループの識別子>.json        ループの 1 手の記録（loop-history.repository.ts）
 * ```
 *
 * `Card` の `startedAt` は `log/` の着手のファイルから、`rank` は `order.yaml` から、
 * 本文の `## レビュー` は `log/` の判断のファイルから組み立てる。`card.md` はこの 3 つを持たない。
 * ここはファイルの中身の文字列とファイル名だけを扱い、読み書きと git はリポジトリと `DataStore` が行う。
 */

export const DATA_VERSION_FILE = 'ai-board-data.yaml';
export const ORDER_FILE = 'order.yaml';
export const CARDS_DIR = 'cards';
export const CARD_FILE = 'card.md';
export const LOG_DIR = 'log';

/** この版の CLI が読み書きできる形の版。これより新しい版は読まずに止まる */
export const DATA_VERSION = 1;

// ============================================================
// エラー
// ============================================================

export type DataVersionError =
  | { readonly type: 'UnsupportedDataVersion'; readonly found: number; readonly supported: number }
  | { readonly type: 'MalformedDataVersion'; readonly reason: string };

export type OrderFileError = { readonly type: 'MalformedOrderFile'; readonly reason: string };

export type CardWriteError =
  /** 保存しようとする本文が、既存の判断のエントリを変えている・消している・増やしている */
  | { readonly type: 'ReviewEntriesChanged'; readonly id: CardId }
  /** 足す着手のファイルが `log/` の最新にならない（既存の着手・着手を戻すより古い時刻） */
  | { readonly type: 'StartedAtOutOfOrder'; readonly id: CardId; readonly startedAt: string }
  /** 判断のファイル名にできない時刻 */
  | { readonly type: 'InvalidLogTime'; readonly id: CardId; readonly at: string }
  /** 今の `card.md` が読めない */
  | { readonly type: 'MalformedCardFile'; readonly id: CardId };

// ============================================================
// ai-board-data.yaml — 形の版
// ============================================================

export function serializeDataVersion(): string {
  return stringifyYaml({ version: DATA_VERSION });
}

/** 形の版を読む。この CLI より新しい版なら、中身を読まずに失敗する */
export function parseDataVersion(raw: string): Result<number, DataVersionError> {
  let data: unknown;
  try {
    data = parseYaml(raw) as unknown;
  } catch (error) {
    return err({ type: 'MalformedDataVersion', reason: errorMessage(error) });
  }

  const result = z.object({ version: z.number().int().positive() }).safeParse(data);
  if (!result.success) {
    return err({
      type: 'MalformedDataVersion',
      reason: `${DATA_VERSION_FILE} に version（正の整数）がありません`,
    });
  }

  const { version } = result.data;
  if (version > DATA_VERSION) {
    return err({ type: 'UnsupportedDataVersion', found: version, supported: DATA_VERSION });
  }

  return ok(version);
}

// ============================================================
// order.yaml — rank とアイデアの区切り線
// ============================================================

export interface OrderFile {
  /** アイデアの表の区切り線。一度も動かしていなければ null */
  readonly divider: number | null;
  /** rank のあるカードだけを持つ。rank の無いカードは書かない */
  readonly ranks: Readonly<Record<string, number>>;
}

export const EMPTY_ORDER: OrderFile = { divider: null, ranks: {} };

const OrderFileSchema = z.object({
  divider: z.number().finite().nullable().default(null),
  ranks: z.record(z.string(), z.unknown()).nullable().default({}),
});

/**
 * `order.yaml` を読む。ファイルが無い・空なら `EMPTY_ORDER`。
 *
 * 形そのものが壊れていれば失敗にする（読み流して書き戻すと、全カードの rank を失う）。
 * ID として不正なキーや数でない rank は、警告して読み飛ばす（1 枚でボード全体を止めない）。
 */
export function parseOrder(raw: string | null): Result<OrderFile, OrderFileError> {
  if (raw === null || raw.trim() === '') return ok(EMPTY_ORDER);

  let data: unknown;
  try {
    data = parseYaml(raw) as unknown;
  } catch (error) {
    return err({ type: 'MalformedOrderFile', reason: errorMessage(error) });
  }

  const result = OrderFileSchema.safeParse(data);
  if (!result.success) {
    return err({
      type: 'MalformedOrderFile',
      reason: result.error.issues.map((issue) => issue.message).join(', '),
    });
  }

  const ranks: Record<string, number> = {};
  for (const [id, rank] of Object.entries(result.data.ranks ?? {})) {
    if (!CardIdSchema.safeParse(id).success || typeof rank !== 'number' || !Number.isFinite(rank)) {
      console.warn(`[ai-board] ${ORDER_FILE} の rank を読み飛ばしました: ${id}`);
      continue;
    }
    ranks[id] = rank;
  }

  return ok({ divider: result.data.divider, ranks });
}

/** `order.yaml` に戻す。差分が並びに左右されないよう、rank は ID の順に書く */
export function serializeOrder(order: OrderFile): string {
  const ranks = Object.fromEntries(
    Object.entries(order.ranks).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  );

  return stringifyYaml({ divider: order.divider, ranks });
}

/** カードの rank を差し替える。null なら `ranks` から消す */
export function withRank(order: OrderFile, id: CardId, rank: number | null): OrderFile {
  const { [id]: _removed, ...rest } = order.ranks;

  return { ...order, ranks: rank === null ? rest : { ...rest, [id]: rank } };
}

// ============================================================
// log/ — 判断 1 件 1 ファイル
// ============================================================

/** `log/` のゲート。`start` は着手 / 着手を戻すで、`## レビュー` には出さない */
export type LogGate = ReviewGate | 'start';

export type StartKind = 'start' | 'unstart';

/** ファイル名の種別。日本語のファイル名は git の出力でエスケープされて読みにくいので英字にする */
const REVIEW_KIND_NAMES = {
  提出: 'submit',
  再提出: 'resubmit',
  保留: 'hold',
  承認: 'approve',
  否決: 'reject',
  中止: 'abort',
} as const satisfies Record<ReviewKind, string>;

type ReviewKindName = (typeof REVIEW_KIND_NAMES)[ReviewKind];

const REVIEW_KINDS_BY_NAME = new Map<string, ReviewKind>(
  Object.entries(REVIEW_KIND_NAMES).map(([kind, name]) => [name, kind as ReviewKind])
);

/** 判断のファイル 1 つ。`name` は `log/` の中のファイル名 */
export interface LogFile {
  readonly name: string;
  readonly content: string;
}

/** ファイル名から読み取った判断。`seq` は同じミリ秒に重なったときの連番（無ければ 1） */
export type LogName =
  | {
      readonly at: string;
      readonly gate: ReviewGate;
      readonly kind: ReviewKind;
      readonly seq: number;
    }
  | {
      readonly at: string;
      readonly gate: 'start';
      readonly kind: StartKind;
      readonly seq: number;
    };

/** `20261101T035208.000Z.plan.submit.md`、重なれば `…submit-2.md` */
const LOG_NAME = /^(\d{8}T\d{6}\.\d{3}Z)\.([a-z]+)\.([a-z]+)(?:-([1-9]\d*))?\.md$/;

const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/;

/**
 * ISO 8601 の時刻を、ファイル名に使う `20261101T035208.000Z`（コロンを含まない、ミリ秒まで）にする。
 * 時刻として読めない・4 桁の年に収まらないなら null。
 */
export function toLogStamp(at: string): string | null {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return null;

  const year = new Date(ms).getUTCFullYear();
  if (year < 0 || year > 9999) return null;

  return new Date(ms).toISOString().replace(/[-:]/g, '');
}

/** `toLogStamp` の逆。`2026-11-01T03:52:08.000Z` の形に戻す */
export function fromLogStamp(stamp: string): string | null {
  const match = STAMP.exec(stamp);
  if (match === null) return null;

  const [, year, month, day, hour, minute, second, milli] = match;
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.${milli}Z`;
  const ms = Date.parse(iso);

  // 13 月や 25 時のような、Date が丸めてしまう値を通さない
  return !Number.isNaN(ms) && new Date(ms).toISOString() === iso ? iso : null;
}

/** 判断のファイル名を読む。形が違う・ゲートと種別の組み合わせが規定外なら null */
export function parseLogFileName(name: string): LogName | null {
  const match = LOG_NAME.exec(name);
  if (match === null) return null;

  const [, stamp, gate, kindName, seqText] = match;
  if (stamp === undefined || gate === undefined || kindName === undefined) return null;

  const at = fromLogStamp(stamp);
  if (at === null) return null;

  const seq = seqText === undefined ? 1 : Number(seqText);

  return toLogName(at, gate, kindName, seq);
}

function toLogName(at: string, gate: string, kindName: string, seq: number): LogName | null {
  if (gate === 'start') {
    return kindName === 'start' || kindName === 'unstart'
      ? { at, gate, kind: kindName, seq }
      : null;
  }

  if (gate !== 'plan' && gate !== 'verify') return null;

  const kind = REVIEW_KINDS_BY_NAME.get(kindName);

  return kind === undefined ? null : { at, gate, kind, seq };
}

/**
 * 判断のファイル名を決める。同じミリ秒に同じゲートと種別のファイルが `taken` にあれば、`-2`、`-3` を付ける。
 * 時刻がファイル名にできなければ null。
 */
export function logFileName(
  at: string,
  gate: LogGate,
  kind: ReviewKind | StartKind,
  taken: ReadonlySet<string>
): string | null {
  const stamp = toLogStamp(at);
  if (stamp === null) return null;

  const kindName: ReviewKindName | StartKind =
    gate === 'start' ? (kind as StartKind) : REVIEW_KIND_NAMES[kind as ReviewKind];
  const base = `${stamp}.${gate}.${kindName}`;

  if (!taken.has(`${base}.md`)) return `${base}.md`;

  let seq = 2;
  while (taken.has(`${base}-${seq}.md`)) seq += 1;

  return `${base}-${seq}.md`;
}

/**
 * 判断のファイルの読む順。時刻、ゲートと種別、連番の順に並べる。
 *
 * ファイル名の文字列の順そのままにはしない。`-`（0x2D）は `.`（0x2E）より前なので、
 * `…submit-2.md` が `…submit.md` より前に来て、同じミリ秒の判断の後先が逆になる（`-10` と `-2` も同じ）。
 * `gateState` は同じ時刻なら後ろのものを採るので、並びがそのまま結果になる。
 */
export function compareLogNames(a: LogName, b: LogName): number {
  return (
    compareStrings(a.at, b.at) ||
    compareStrings(`${a.gate}.${kindNameOf(a)}`, `${b.gate}.${kindNameOf(b)}`) ||
    a.seq - b.seq
  );
}

function kindNameOf(name: LogName): string {
  return name.gate === 'start' ? name.kind : REVIEW_KIND_NAMES[name.kind];
}

/** 判断のファイルの中身。理由の本文を前後の空白を落として置く。空なら空のファイル */
function logContent(reason: string): string {
  const trimmed = reason.trim();

  return trimmed === '' ? '' : `${trimmed}\n`;
}

interface ReadLogEntry {
  readonly name: LogName;
  readonly reason: string;
}

/** `log/` のファイルを読む順に並べる。名前の読めないファイルは警告して読み飛ばす */
function readLog(id: string, files: readonly LogFile[]): ReadLogEntry[] {
  const entries: ReadLogEntry[] = [];

  for (const file of files) {
    const name = parseLogFileName(file.name);
    if (name === null) {
      console.warn(`[ai-board] 判断のファイルを読み飛ばしました: ${id}/${LOG_DIR}/${file.name}`);
      continue;
    }
    entries.push({ name, reason: file.content.trim() });
  }

  return entries.sort((a, b) => compareLogNames(a.name, b.name));
}

/** 着手の時刻。`start` ゲートの最新が着手ならその時刻、着手を戻すか無ければ null */
function startedAtOf(entries: readonly ReadLogEntry[]): string | null {
  const latest = entries.filter((entry) => entry.name.gate === 'start').at(-1);

  return latest !== undefined && latest.name.kind === 'start' ? latest.name.at : null;
}

// ============================================================
// card.md と、Card の組み立て
// ============================================================

/** 1 枚のカードのファイル。`log` は `log/` の全ファイル */
export interface CardFiles {
  readonly cardMd: string;
  readonly log: readonly LogFile[];
}

/** `card.md` が持つ項目。`startedAt` と `rank` と `## レビュー` は持たない */
type CardFileFields = Omit<Card, 'startedAt' | 'rank' | 'body'>;

interface ParsedCardFile {
  readonly fields: CardFileFields;
  /** `## レビュー` の節を除いた本文 */
  readonly body: string;
}

/**
 * `card.md` を読む。ディレクトリ名の ID と frontmatter の `id` が食い違う・項目が不正なら、
 * 警告して null を返す（1 枚でボード全体を止めない）。
 * frontmatter に `startedAt` や `rank` があっても読まない。本文の `## レビュー` の節も読まない。
 */
function parseCardFile(id: string, raw: string): ParsedCardFile | null {
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (error) {
    warnCardFile(id, errorMessage(error));
    return null;
  }

  const data = parsed.data as Record<string, unknown>;
  const result = CardFrontmatterSchema.safeParse({
    id: data['id'],
    title: data['title'],
    created: data['created'],
    skipGates: data['skipGates'],
    branch: data['branch'],
    mr: data['mr'],
  });

  if (!result.success) {
    warnCardFile(id, result.error.issues.map((issue) => issue.message).join(', '));
    return null;
  }

  const frontmatter = result.data;
  if (frontmatter.id !== id) {
    warnCardFile(id, `frontmatter の id (${frontmatter.id}) がディレクトリ名と一致しません`);
    return null;
  }

  return {
    fields: {
      id: frontmatter.id as CardId,
      title: frontmatter.title,
      created: frontmatter.created,
      skipGates: frontmatter.skipGates,
      branch: frontmatter.branch,
      mr: frontmatter.mr as MergeRequestIid | null,
    },
    body: stripReviewSection(parsed.content),
  };
}

/** `card.md` に戻す。frontmatter のキーの順は固定する */
export function serializeCardFile(fields: CardFileFields, body: string): string {
  const frontmatter = {
    id: fields.id,
    title: fields.title,
    created: fields.created,
    skipGates: fields.skipGates,
    branch: fields.branch,
    mr: fields.mr,
  };
  const normalized = trimNewlines(body);

  return matter.stringify(normalized === '' ? '' : `\n${normalized}\n`, frontmatter);
}

/**
 * 1 枚のカードのファイルから `Card` を組み立てる。`card.md` が読めなければ警告して null。
 *
 * 本文は、`card.md` の本文の末尾に、`log/` の判断から作った `## レビュー` の節を付けたものになる。
 * 節は `appendReviewEntry` を判断の順に重ねて作るので、画面や CLI が判断を足したときの本文と同じ形になる。
 * 判断が 1 件も無ければ `## レビュー` の見出しも付けない。
 * 理由の中の見出しは `####` へ下げる（`demoteHeadings`）。ファイルには元の文のまま残る。
 */
export function assembleCard(id: string, files: CardFiles, rank: number | null): Card | null {
  const parsed = parseCardFile(id, files.cardMd);
  if (parsed === null) return null;

  const log = readLog(id, files.log);

  return {
    ...parsed.fields,
    startedAt: startedAtOf(log),
    rank,
    body: log.reduce(
      (body, entry) =>
        entry.name.gate === 'start'
          ? body
          : appendReviewEntry(body, {
              at: entry.name.at,
              gate: entry.name.gate,
              kind: entry.name.kind,
              reason: demoteHeadings(entry.reason),
            }),
      parsed.body
    ),
  };
}

/**
 * 理由の中の `#`〜`###` の見出しの行を `####` へ下げる。
 *
 * 下げないと、理由の中の `## ` で `## レビュー` の節が途中で切れ、`### <時刻> <gate> <種別>` の行は
 * 別の判断として読まれる。`parseReviewLog` はコードブロックを区別しないので、ここも区別せずに下げる
 * （シェルのコメントの `# ` は `#### ` になっても、コメントのままである）。
 */
export function demoteHeadings(text: string): string {
  return text.replace(/^#{1,3}(?=\s|$)/gm, '####');
}

// ============================================================
// Card の差分から、書くファイルを求める
// ============================================================

/** 今のカードのファイル。新しいカードなら null を渡す */
export interface StoredCard {
  readonly files: CardFiles;
  readonly rank: number | null;
}

export interface CardWrite {
  /** 書き換える `card.md` の中身。変わらなければ null */
  readonly cardMd: string | null;
  /** `log/` に足すファイル。既存のファイルは書き換えも削除もしない */
  readonly logFiles: readonly LogFile[];
  /** rank が変わったか。変わったら `withRank` で `order.yaml` を書き換える */
  readonly rankChanged: boolean;
}

/**
 * 保存しようとする `Card` と今のファイルを比べて、書くファイルを求める。
 *
 * - 本文とメタ（と着手）だけを書き、判断のファイルは決して作らない。判断を足すのは `planReviewAppend` である
 * - 本文が `## レビュー` の節を持たなければ（`hasReviewSection`）、判断は変えないと読み、本文をそのまま書く。
 *   判断は `log/` にあり、本文の保存は `log/` のファイルを消さないので、節の無い本文で判断が消えることはない
 * - 節を持つ本文は、`parseReviewLog` で読んだ判断が今と同じでなければ、書かずに `ReviewEntriesChanged` で失敗する
 *   （判断を足した本文・変えた本文・エントリを消した本文のどれも拒む）。
 *   同じなら、`card.md` の本文には `## レビュー` の節を除いた本文を書く
 * - 新しいカード（`stored` が null）は、本文の節に判断があれば失敗する
 * - `startedAt` が変われば、着手（その時刻）か着手を戻す（`now`）のファイルを足す
 *
 * 本文の形から判断の追記を推し量らないので、理由に判断の見出しの形の行が混ざっていても、
 * 本文の保存から判断が増えることはない。
 */
export function planCardWrite(
  stored: StoredCard | null,
  next: Card,
  now: string
): Result<CardWrite, CardWriteError> {
  const current = readStored(next.id, stored);
  if (current === undefined) return err({ type: 'MalformedCardFile', id: next.id });

  const additions = new LogAdditions(next.id, stored?.files.log ?? []);

  const body = planBody(current, next);
  if (!body.ok) return body;

  const started = planStartedAt(current, next, now, additions);
  if (!started.ok) return started;

  const cardMd = serializeCardFile(next, body.value);
  const unchanged =
    current !== null && cardMd === serializeCardFile(current.file.fields, current.file.body);

  return ok({
    cardMd: unchanged ? null : cardMd,
    logFiles: additions.files,
    rankChanged: (current?.card.rank ?? null) !== next.rank,
  });
}

interface CurrentCard {
  readonly card: Card;
  readonly file: ParsedCardFile;
}

/**
 * 判断を 1 件足すときに書く `log/` のファイルを求める。
 *
 * 判断は値のまま受け取り、理由はファイルの中身になるだけで、見出しとして読み直さない。
 * ファイル名は `logFileName`（同じミリ秒に重なれば `-2`）、中身は理由の前後の空白を落としたもの。
 * `card.md` には触らない。
 *
 * 今の `card.md` が読めなければ `MalformedCardFile`、時刻がファイル名にできなければ `InvalidLogTime`。
 */
export function planReviewAppend(
  id: CardId,
  stored: StoredCard,
  entry: ReviewEntry
): Result<LogFile, CardWriteError> {
  if (parseCardFile(id, stored.files.cardMd) === null) {
    return err({ type: 'MalformedCardFile', id });
  }

  const taken = new Set(stored.files.log.map((file) => file.name));
  const name = logFileName(entry.at, entry.gate, entry.kind, taken);
  if (name === null) return err({ type: 'InvalidLogTime', id, at: entry.at });

  return ok({ name, content: logContent(entry.reason) });
}

/** 今のカードを読む。新しいカードなら null、`card.md` が読めなければ undefined */
function readStored(id: CardId, stored: StoredCard | null): CurrentCard | null | undefined {
  if (stored === null) return null;

  const card = assembleCard(id, stored.files, stored.rank);
  const file = parseCardFile(id, stored.files.cardMd);

  return card === null || file === null ? undefined : { card, file };
}

/** 足す判断のファイル。同じ書き込みの中で足したファイルも、`-2` の連番を決めるときに数える */
class LogAdditions {
  private readonly taken: Set<string>;
  readonly files: LogFile[] = [];

  constructor(
    private readonly id: CardId,
    private readonly existing: readonly LogFile[]
  ) {
    this.taken = new Set(existing.map((file) => file.name));
  }

  add(
    at: string,
    gate: LogGate,
    kind: ReviewKind | StartKind,
    reason: string
  ): CardWriteError | null {
    const name = logFileName(at, gate, kind, this.taken);
    if (name === null) return { type: 'InvalidLogTime', id: this.id, at };

    this.taken.add(name);
    this.files.push({ name, content: logContent(reason) });
    return null;
  }

  /** 足した後の `log/` から読んだ着手の時刻 */
  startedAt(): string | null {
    return startedAtOf(readLog(this.id, [...this.existing, ...this.files]));
  }
}

/**
 * `card.md` に書く本文を返す。
 *
 * - 節の無い本文: 判断は変えないと読み、そのまま書く
 * - 節のある本文: `## レビュー` の判断が今と違えば `ReviewEntriesChanged`。同じなら節を除いて書く
 *   （エントリの無い見出しだけの節も、今のエントリがあれば違うので拒む）
 *
 * 判断の追記は `planReviewAppend` の口だけで行い、ここでは判断のファイルを足さない。
 */
function planBody(current: CurrentCard | null, next: Card): Result<string, CardWriteError> {
  if (
    hasReviewSection(next.body) &&
    !isDeepStrictEqual(parseReviewLog(current?.card.body ?? ''), parseReviewLog(next.body))
  ) {
    return err({ type: 'ReviewEntriesChanged', id: next.id });
  }

  return ok(stripReviewSection(next.body));
}

/** `startedAt` が変わっていれば、着手か着手を戻すのファイルを足す */
function planStartedAt(
  current: CurrentCard | null,
  next: Card,
  now: string,
  additions: LogAdditions
): Result<null, CardWriteError> {
  const currentStartedAt = current?.card.startedAt ?? null;
  if (sameInstant(currentStartedAt, next.startedAt)) return ok(null);

  const failure =
    next.startedAt === null
      ? // 着手の時刻より前に戻すと、最新が着手のまま残る。同じ時刻なら unstart が後ろに並ぶ
        additions.add(latestInstant(now, currentStartedAt), 'start', 'unstart', '')
      : additions.add(next.startedAt, 'start', 'start', '');
  if (failure !== null) return err(failure);

  if (next.startedAt !== null && !sameInstant(additions.startedAt(), next.startedAt)) {
    return err({ type: 'StartedAtOutOfOrder', id: next.id, startedAt: next.startedAt });
  }

  return ok(null);
}

// ============================================================
// ヘルパー
// ============================================================

function trimNewlines(text: string): string {
  return text.replace(/^\n+/, '').replace(/\n+$/, '');
}

function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;

  return Date.parse(a) === Date.parse(b);
}

function latestInstant(a: string, b: string | null): string {
  return b !== null && Date.parse(b) > Date.parse(a) ? b : a;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function warnCardFile(id: string, reason: string): void {
  console.warn(`[ai-board] カードを読み飛ばしました: ${CARDS_DIR}/${id}/${CARD_FILE} — ${reason}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
