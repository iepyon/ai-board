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

export const REVIEW_HEADING = '## レビュー';

/** `### <ISO8601> <gate> <種別>` */
const ENTRY_HEADING = /^###\s+(\S+)\s+(\S+)\s+(\S+)\s*$/;

/** 見出しから読み取った、理由文がまだ確定していないエントリ */
export interface PendingEntry {
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

/**
 * 本文が `## レビュー` の節を持つか。`trim()` が `## レビュー` に等しい行があるかで決める
 * （`parseReviewLog` と `stripReviewSection` が節を探すのと同じ読み方）。
 */
export function hasReviewSection(body: string): boolean {
  return body.split('\n').some((line) => line.trim() === REVIEW_HEADING);
}

/**
 * 本文から `## レビュー` の節（見出しから次の h2 の手前まで）を除く。
 * `parseReviewLog` と同じ切り方なので、節の後ろに置かれた節は本文に残る。
 * 前後の空行は落とす。
 */
export function stripReviewSection(body: string): string {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => line.trim() === REVIEW_HEADING);
  if (start === -1) return trimNewlines(body);

  const offset = lines.slice(start + 1).findIndex((line) => line.startsWith('## '));
  const end = offset === -1 ? lines.length : start + 1 + offset;

  return trimNewlines([...lines.slice(0, start), ...lines.slice(end)].join('\n'));
}

function trimNewlines(text: string): string {
  return text.replace(/^\n+/, '').replace(/\n+$/, '');
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
 * `skipGates` に宣言されたゲートでは、AI の 提出 / 再提出 を人の承認と同じに読む（`approved`）。
 * 人が事前に「このカードのこのゲートは見ない」と決めた意思表示だからである。
 * ログを見ずに通過扱いにはしないので、エントリが無ければ `none` で、否決 / 保留 / 承認 はふつうに効く。
 * 計画を書く手や着手の合図を飛ばさずに、人が読む関所だけを飛ばすためである。
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
  const latest = latestGateEntry(entries, gate);
  if (latest === null) return 'none';

  switch (latest.kind) {
    case '承認':
      return 'approved';
    case '否決':
      return 'rejected';
    case '提出':
    case '再提出':
      return skipGates.includes(gate) ? 'approved' : 'submitted';
    case '保留':
      return 'held';
    case '中止':
      // latestGateEntry が除いている。網羅性のために残す
      return 'none';
  }
}

/** 全ゲートの通過状況をまとめて返す。各ゲートの規則は `gateState()` と同じ */
export function gateStates(
  entries: readonly ReviewEntry[],
  skipGates: readonly ReviewGate[]
): Record<ReviewGate, GateState> {
  return {
    plan: gateState(entries, 'plan', skipGates),
  };
}

/**
 * ゲートの最新エントリ（中止を除く）。無ければ null。`gate` が undefined ならゲートを問わず最新を選ぶ。
 *
 * `gateState()` はこの関数でエントリを選ぶので、返るエントリの種別は常にゲートの状態と一致する
 * （宣言のあるゲートの 提出 / 再提出 は `approved` と読まれるが、種別は書き換えずに返す。
 * AI が書いたものを人の承認と見せると、誰が何を書いたかを読み違えるため）。
 * 人が判断するときの材料（提出に書かれた判断待ちの点）と、待ち始めた時刻を `status` の判断待ちに出すために使う。
 */
export function latestGateEntry(
  entries: readonly ReviewEntry[],
  gate?: ReviewGate
): ReviewEntry | null {
  return latestOf(
    entries.filter((entry) => (gate === undefined || entry.gate === gate) && entry.kind !== '中止')
  );
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
