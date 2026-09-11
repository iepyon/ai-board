import {
  isReviewGate,
  isReviewKind,
  type GateState,
  type ReviewEntry,
  type ReviewGate,
  type ReviewKind,
} from '../models/review.js';

// ============================================================
// レビューログの解析 — 純関数のみ。I/O は持たない
// ============================================================

const REVIEW_HEADING = '## レビュー';

/** `### <ISO8601> <gate> <種別>` */
const ENTRY_HEADING = /^###\s+(\S+)\s+(\S+)\s+(\S+)\s*$/;

/** 見出しから読み取った、理由文がまだ確定していないエントリ */
interface PendingEntry {
  readonly at: string;
  readonly gate: ReviewGate;
  readonly kind: ReviewKind;
}

/**
 * 本文の `## レビュー` セクションを解析する。
 *
 * 書式の壊れた見出しは黙って無視する。カードは人が直接編集してよいファイルであり、
 * 手書きの揺れでボード全体が読めなくなるほうが害が大きいため。
 */
export function parseReviewLog(body: string): ReviewEntry[] {
  const section = extractSection(body, REVIEW_HEADING);
  if (section === null) return [];

  const entries: ReviewEntry[] = [];
  let pending: PendingEntry | null = null;
  let reasonLines: string[] = [];

  const flush = (): void => {
    if (pending !== null) {
      entries.push({ ...pending, reason: reasonLines.join('\n').trim() });
    }
    pending = null;
    reasonLines = [];
  };

  for (const line of section) {
    const match = ENTRY_HEADING.exec(line);

    if (match === null) {
      if (pending !== null) reasonLines.push(line);
      continue;
    }

    flush();
    pending = toPendingEntry(match);
  }

  flush();

  return entries;
}

/** 正規表現のキャプチャを検証済みのエントリ見出しへ変換する。不正なら null */
function toPendingEntry(match: RegExpExecArray): PendingEntry | null {
  const [, at, gate, kind] = match;

  if (at === undefined || gate === undefined || kind === undefined) return null;
  if (Number.isNaN(Date.parse(at))) return null;
  if (!isReviewGate(gate)) return null;
  if (!isReviewKind(kind)) return null;

  return { at, gate, kind };
}

/**
 * 指定した h2 見出しの中身を行の配列で返す。次の h2 で打ち切る。
 * 見出しが無ければ null。
 */
function extractSection(body: string, heading: string): string[] | null {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);

  if (start === -1) return null;

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));

  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * ゲートの通過状況。
 *
 * `skipGates` に宣言されたゲートはログを見ずに通過扱いにする。
 * 人が事前に「このカードのこのゲートは見ない」と決めた意思表示だからである。
 *
 * 中止のエントリは判定から除く。中止は工程の進捗とは直交する終端の軸であり、
 * 承認済みのゲートを未通過へ巻き戻してはならない（それをするとカードを
 * 中止した瞬間にステージが前の列へ戻る）。
 */
export function gateState(
  entries: readonly ReviewEntry[],
  gate: ReviewGate,
  skipGates: readonly ReviewGate[]
): GateState {
  if (skipGates.includes(gate)) return 'approved';

  const latest = latestOf(entries.filter((entry) => entry.gate === gate && entry.kind !== '中止'));
  if (latest === null) return 'none';

  switch (latest.kind) {
    case '承認':
      return 'approved';
    case '否決':
      return 'rejected';
    case '提出':
    case '再提出':
      return 'submitted';
    case '中止':
      // 上でフィルタ済み。網羅性のために残す
      return 'none';
  }
}

/** 全エントリを通じて最新のものが 中止 か */
export function isAborted(entries: readonly ReviewEntry[]): boolean {
  return latestOf(entries)?.kind === '中止';
}

/** 時刻が最も新しいエントリ。同時刻なら後に書かれたほうを採る */
function latestOf(entries: readonly ReviewEntry[]): ReviewEntry | null {
  let latest: ReviewEntry | null = null;

  for (const entry of entries) {
    if (latest === null || Date.parse(entry.at) >= Date.parse(latest.at)) {
      latest = entry;
    }
  }

  return latest;
}

// ============================================================
// レビューログへの追記
// ============================================================

/**
 * レビューエントリを本文へ追記する。
 *
 * `## レビュー` が無ければ本文の末尾にセクションごと作る。
 * あればそのセクションの末尾（次の h2 の手前）へ足す。
 */
export function appendReviewEntry(body: string, entry: ReviewEntry): string {
  const block = renderEntry(entry);
  const lines = body.split('\n');
  const start = lines.findIndex((line) => line.trim() === REVIEW_HEADING);

  if (start === -1) {
    const head = body.trimEnd();
    const prefix = head === '' ? '' : `${head}\n\n`;
    return `${prefix}${REVIEW_HEADING}\n\n${block}`;
  }

  const rest = lines.slice(start + 1);
  const offset = rest.findIndex((line) => line.startsWith('## '));

  if (offset === -1) {
    return `${body.trimEnd()}\n\n${block}`;
  }

  const before = lines
    .slice(0, start + 1 + offset)
    .join('\n')
    .trimEnd();
  const after = lines.slice(start + 1 + offset).join('\n');

  return `${before}\n\n${block}\n${after}`;
}

/** エントリ 1 件の Markdown 表現。末尾に改行を 1 つ持つ */
function renderEntry(entry: ReviewEntry): string {
  const heading = `### ${entry.at} ${entry.gate} ${entry.kind}\n`;

  return entry.reason === '' ? heading : `${heading}\n${entry.reason}\n`;
}
