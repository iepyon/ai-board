// ============================================================
// Markdown の整形 — カードの本文を表示用の木に変える純関数
// ============================================================

/**
 * 本文を表示するための木。HTML の文字列は作らず、描画は web が React の要素に写すだけにする。
 * 本文は人もエージェントも書ける場所なので、HTML として流し込むと画面でスクリプトを動かせてしまう。
 *
 * カードの本文で使う記法に絞る（CommonMark には準拠しない）。
 * 知らない書き方は段落の文字としてそのまま残し、どんな入力にも木を返す。
 */
export type Block = HeadingBlock | ParagraphBlock | ListBlock | CodeBlock | RowsBlock;

export interface HeadingBlock {
  readonly type: 'heading';
  readonly level: number;
  readonly text: string;
}

/** 段落。一文一行で書いた本文を 1 行につながないよう、行のまま持つ */
export interface ParagraphBlock {
  readonly type: 'paragraph';
  readonly lines: readonly string[];
}

/**
 * 箇条書き。項目の 2 行目以降（続きの行）も行のまま持つ。
 * `start` は番号付きのときの最初の番号（番号の無い箇条書きでは 1）。
 */
export interface ListBlock {
  readonly type: 'list';
  readonly ordered: boolean;
  readonly start: number;
  readonly items: readonly ListItem[];
}

/**
 * 項目。`lines` は項目の行と続きの行、`children` はその下に続くブロック
 * （深くインデントされた箇条書き、インデントされたコードブロック、子の後に戻ってきた続きの行）
 */
export interface ListItem {
  readonly lines: readonly string[];
  readonly children: readonly Block[];
}

/** フェンスのコード。`info` は開くフェンスの後ろの文字列（言語名など）で、無ければ `null` */
export interface CodeBlock {
  readonly type: 'code';
  readonly info: string | null;
  readonly text: string;
}

/** `|` で始まる行の並び（表）。整形せず、等幅のまま出す */
export interface RowsBlock {
  readonly type: 'rows';
  readonly lines: readonly string[];
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
/** `- - -` や `***` などの区切り線。箇条書きの項目にはしない（区切り線は描かず、文字のまま残す） */
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ROW = /^[ \t]*\|/;

const TAB_WIDTH = 4;

interface Cursor {
  readonly lines: readonly string[];
  pos: number;
}

interface FenceLine {
  readonly fence: string;
  readonly info: string;
  /** 開くフェンスの行頭の空白の幅。中身の各行からこの幅まで空白を外す */
  readonly indent: number;
}

interface ItemLine {
  readonly indent: number;
  readonly ordered: boolean;
  readonly start: number;
  readonly text: string;
}

interface MutableItem {
  readonly lines: string[];
  readonly children: Block[];
  /** 子のブロックの後に戻ってきた続きの行を集める段落。子を足したら閉じる */
  tail: string[] | null;
}

/** 本文をブロックの並びに変える */
export function parseBlocks(body: string): Block[] {
  const cursor: Cursor = { lines: body.replace(/\r\n?/g, '\n').split('\n'), pos: 0 };
  const blocks: Block[] = [];

  while (cursor.pos < cursor.lines.length) {
    const block = readBlock(cursor);
    if (block !== null) blocks.push(block);
  }

  return blocks;
}

/**
 * 判断の理由をブロックの並びに変える。`parseBlocks` と同じに読んでから、見出しのブロックを
 * 記号（`#`）を残した 1 行の段落に置き換える。箇条書きの項目の子も同じに辿る。
 *
 * 理由は画面が値から描く判断の見出しの下に出すので、理由の中の行が見出しに見えないようにする。
 * `parseBlocks` 自体の読み方は変えない（見出しの行は段落の切れ目にもなるので、読み方を変えると本文の描き方に触れる）。
 */
export function parseReasonBlocks(reason: string): Block[] {
  return parseBlocks(reason).map(flattenHeading);
}

function flattenHeading(block: Block): Block {
  if (block.type === 'heading') {
    return { type: 'paragraph', lines: [`${'#'.repeat(block.level)} ${block.text}`] };
  }
  if (block.type === 'list') {
    return {
      ...block,
      items: block.items.map((item) => ({ ...item, children: item.children.map(flattenHeading) })),
    };
  }
  return block;
}

/** 今の行から 1 ブロックを読む。空行は読み飛ばして `null` を返す。どの場合も 1 行以上進める */
function readBlock(cursor: Cursor): Block | null {
  const line = current(cursor);

  if (isBlank(line)) {
    cursor.pos++;
    return null;
  }
  const fence = matchFence(line);
  if (fence !== null) return readCode(cursor, fence);

  const heading = HEADING.exec(line);
  if (heading !== null) {
    cursor.pos++;
    return { type: 'heading', level: (heading[1] ?? '#').length, text: heading[2] ?? '' };
  }

  if (ROW.test(line)) return readRows(cursor);

  const item = matchItem(line);
  if (item !== null) return readList(cursor, item);

  return readParagraph(cursor);
}

/** 閉じるフェンスまで。閉じていなければ本文の終わりまでをコードとする */
function readCode(cursor: Cursor, open: FenceLine): CodeBlock {
  cursor.pos++;

  const text: string[] = [];
  while (cursor.pos < cursor.lines.length) {
    const line = dedent(current(cursor), open.indent);
    cursor.pos++;
    if (closesFence(line, open.fence)) break;
    text.push(line);
  }

  return { type: 'code', info: open.info === '' ? null : open.info, text: text.join('\n') };
}

/** 開くフェンス。バッククォートのフェンスの後ろにバッククォートがあれば、フェンスではない（インラインコード） */
function matchFence(line: string): FenceLine | null {
  const match = FENCE.exec(line);
  if (match === null) return null;

  const fence = match[1] ?? '```';
  const info = (match[2] ?? '').trim();
  if (fence.startsWith('`') && info.includes('`')) return null;

  return { fence, info, indent: indentOf(line) };
}

/** 開いたフェンスと同じ文字で、同じ長さ以上のものだけが閉じる */
function closesFence(line: string, fence: string): boolean {
  const close = CLOSING_FENCE.exec(line)?.[1];
  return close !== undefined && close[0] === fence[0] && close.length >= fence.length;
}

function readRows(cursor: Cursor): RowsBlock {
  const lines: string[] = [];
  while (cursor.pos < cursor.lines.length && ROW.test(current(cursor))) {
    lines.push(current(cursor).trim());
    cursor.pos++;
  }
  return { type: 'rows', lines };
}

/** 空行か、ほかのブロックの始まりまで。最初の行は必ず読む */
function readParagraph(cursor: Cursor): ParagraphBlock {
  const lines = [current(cursor).trim()];
  cursor.pos++;

  while (cursor.pos < cursor.lines.length) {
    const line = current(cursor);
    if (isBlank(line) || startsBlock(line)) break;
    lines.push(line.trim());
    cursor.pos++;
  }

  return { type: 'paragraph', lines };
}

/**
 * `first` の行から、同じインデントの項目が続くあいだを 1 つの箇条書きとして読む。
 *
 * - より深い項目は直前の項目の子の箇条書きにする
 * - より浅い項目、番号付きかどうかが変わる項目で終わる（呼び出し元が続きを読む）
 * - 項目の下の、項目より深くインデントされた行と、空行を挟まずに続く行は、その項目の続きの行にする
 */
function readList(cursor: Cursor, first: ItemLine): ListBlock {
  const items: MutableItem[] = [];

  while (cursor.pos < cursor.lines.length && stepList(cursor, first, items)) {
    // stepList が 1 行以上進める
  }

  return {
    type: 'list',
    ordered: first.ordered,
    start: first.start,
    items: items.map(({ lines, children }) => ({ lines, children })),
  };
}

/** 箇条書きの 1 歩。読み進めたら true、箇条書きが終わったら false（行は進めない） */
function stepList(cursor: Cursor, first: ItemLine, items: MutableItem[]): boolean {
  const line = current(cursor);
  const item = matchItem(line);
  const last = items.at(-1);

  if (item !== null) return stepItem(cursor, first, item, items);
  if (isBlank(line)) return skipBlankInList(cursor, first.indent);
  if (last === undefined) return false;

  const indented = indentOf(line) > first.indent;
  const fence = indented ? matchFence(line.trimStart()) : null;
  if (fence !== null) {
    pushChild(last, readCode(cursor, { ...fence, indent: indentOf(line) }));
    return true;
  }

  if (indented || !startsBlock(line)) {
    pushText(last, line.trim());
    cursor.pos++;
    return true;
  }

  return false;
}

function pushChild(item: MutableItem, block: Block): void {
  item.children.push(block);
  item.tail = null;
}

/** 続きの行。子のブロックより後に来たものは、子の後ろの段落にして順序を保つ */
function pushText(item: MutableItem, text: string): void {
  if (item.children.length === 0) {
    item.lines.push(text);
  } else if (item.tail !== null) {
    item.tail.push(text);
  } else {
    item.tail = [text];
    item.children.push({ type: 'paragraph', lines: item.tail });
  }
}

function stepItem(cursor: Cursor, first: ItemLine, item: ItemLine, items: MutableItem[]): boolean {
  const last = items.at(-1);

  if (item.indent > first.indent && last !== undefined) {
    pushChild(last, readList(cursor, item));
    return true;
  }
  if (item.indent !== first.indent || item.ordered !== first.ordered) return false;

  items.push({ lines: [item.text], children: [], tail: null });
  cursor.pos++;
  return true;
}

/**
 * 箇条書きの中の空行。次の空でない行がこの箇条書きの項目か、項目より深い続きの行なら読み飛ばす。
 * そうでなければ箇条書きはここで終わる。
 */
function skipBlankInList(cursor: Cursor, indent: number): boolean {
  let next = cursor.pos;
  while (next < cursor.lines.length && isBlank(cursor.lines[next] ?? '')) next++;

  const line = cursor.lines[next];
  if (line === undefined) return false;

  const item = matchItem(line);
  const continues = item !== null ? item.indent >= indent : indentOf(line) > indent;
  if (continues) cursor.pos = next;
  return continues;
}

function matchItem(line: string): ItemLine | null {
  if (THEMATIC_BREAK.test(line)) return null;

  const match = LIST_ITEM.exec(line);
  if (match === null) return null;

  const marker = match[2] ?? '-';
  const ordered = /^\d/.test(marker);
  return {
    indent: indentOf(match[1] ?? ''),
    ordered,
    start: ordered ? Number.parseInt(marker, 10) : 1,
    text: (match[3] ?? '').trim(),
  };
}

function startsBlock(line: string): boolean {
  return (
    matchFence(line) !== null || HEADING.test(line) || ROW.test(line) || matchItem(line) !== null
  );
}

/** 行頭の空白の幅。タブは 4 文字分と数える */
function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width++;
    else if (char === '\t') width += TAB_WIDTH;
    else break;
  }
  return width;
}

/** 行頭の空白を `width` の幅まで外す */
function dedent(line: string, width: number): string {
  let removed = 0;
  let index = 0;
  while (index < line.length && removed < width) {
    const char = line[index];
    if (char === ' ') removed++;
    else if (char === '\t') removed += TAB_WIDTH;
    else break;
    index++;
  }
  return line.slice(index);
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function current(cursor: Cursor): string {
  return cursor.lines[cursor.pos] ?? '';
}

// ============================================================
// 行内 — 強調・インラインコード・リンク
// ============================================================

/**
 * 行の中の飾り。ブロックの行（見出しの文字、段落と項目の各行）を描くときに 1 行ずつ変える。
 *
 * 記法の印（`**` やバッククォート、`[...](...)` の括弧）だけを外し、ほかの文字は落とさない。
 * 対にならない印は文字のまま残す。
 */
export type Span = TextSpan | CodeSpan | StrongSpan | LinkSpan;

export interface TextSpan {
  readonly type: 'text';
  readonly text: string;
}

export interface CodeSpan {
  readonly type: 'code';
  readonly text: string;
}

export interface StrongSpan {
  readonly type: 'strong';
  readonly children: readonly Span[];
}

/** `http:` / `https:` のリンクだけ。ほかのスキーム（`javascript:` など）や相対パスは文字のまま残す */
export interface LinkSpan {
  readonly type: 'link';
  readonly href: string;
  readonly children: readonly Span[];
}

const SAFE_HREF = /^https?:\/\//i;

interface InlineOptions {
  /** リンクの文字の中にはリンクを作らない */
  readonly links: boolean;
}

/** 印が見つかった位置から読んだ結果。対にならなかった印は `literal` として文字に戻す */
type InlineMatch =
  | { readonly end: number; readonly span: Span }
  | { readonly end: number; readonly literal: string };

/** 1 行を飾りの並びに変える */
export function parseInline(text: string): Span[] {
  return readSpans(text, { links: true });
}

function readSpans(text: string, options: InlineOptions): Span[] {
  const spans: Span[] = [];
  let buffer = '';
  let pos = 0;

  while (pos < text.length) {
    const match = matchSpan(text, pos, options);

    if (match === null) {
      buffer += text[pos] ?? '';
      pos++;
    } else if ('literal' in match) {
      buffer += match.literal;
      pos = match.end;
    } else {
      if (buffer !== '') spans.push({ type: 'text', text: buffer });
      buffer = '';
      spans.push(match.span);
      pos = match.end;
    }
  }

  if (buffer !== '') spans.push({ type: 'text', text: buffer });
  return spans;
}

function matchSpan(text: string, pos: number, options: InlineOptions): InlineMatch | null {
  if (text[pos] === '`') return matchCode(text, pos);
  if (text.startsWith('**', pos)) return matchStrong(text, pos, options);
  if (text[pos] === '[' && options.links) return matchLink(text, pos);
  return null;
}

/**
 * 同じ本数のバッククォートで閉じるまでをコードにする。閉じなければ開いたバッククォートの並びを文字に戻す。
 * 中身の両端に空白が 1 つずつあれば外す（`` `` ` `` `` でバッククォートを書くため）。
 */
function matchCode(text: string, pos: number): InlineMatch {
  const open = backtickRun(text, pos);
  let next = pos + open;

  while (next < text.length) {
    const close = text.indexOf('`', next);
    if (close === -1) break;

    const run = backtickRun(text, close);
    if (run === open) {
      return {
        end: close + run,
        span: { type: 'code', text: trimCode(text.slice(pos + open, close)) },
      };
    }
    next = close + run;
  }

  return { end: pos + open, literal: text.slice(pos, pos + open) };
}

function backtickRun(text: string, pos: number): number {
  let end = pos;
  while (text[end] === '`') end++;
  return end - pos;
}

function trimCode(code: string): string {
  const padded = code.length >= 2 && code.startsWith(' ') && code.endsWith(' ');
  return padded && code.trim() !== '' ? code.slice(1, -1) : code;
}

/** `**` で挟んだ強調。中身が空か、空白で始まる・終わるときは強調にしない */
function matchStrong(text: string, pos: number, options: InlineOptions): InlineMatch {
  const close = findOutsideCode(text, pos + 2, (at) => text.startsWith('**', at));
  const inner = close === -1 ? '' : text.slice(pos + 2, close);

  if (inner === '' || inner.trim() !== inner) return { end: pos + 2, literal: '**' };

  return { end: close + 2, span: { type: 'strong', children: readSpans(inner, options) } };
}

/**
 * `[文字](URL)`。括弧の中に空白があるもの（タイトル付きなど）はリンクにしない。
 * URL が `http:` / `https:` でなければ、全体を文字に戻す。
 */
function matchLink(text: string, pos: number): InlineMatch | null {
  const labelEnd = findLabelEnd(text, pos);
  if (labelEnd === -1 || text[labelEnd + 1] !== '(') return null;

  const destEnd = findDestEnd(text, labelEnd + 2);
  if (destEnd === -1) return null;

  const href = text.slice(labelEnd + 2, destEnd);
  if (href === '' || /\s/.test(href)) return null;

  const end = destEnd + 1;
  if (!SAFE_HREF.test(href)) return { end, literal: text.slice(pos, end) };

  const label = text.slice(pos + 1, labelEnd);
  const children =
    label === '' ? [{ type: 'text', text: href } as const] : readSpans(label, { links: false });
  return { end, span: { type: 'link', href, children } };
}

/** URL を閉じる `)` の位置。URL の中の対になった括弧（`Foo_(bar)` など）は URL の一部とする */
function findDestEnd(text: string, from: number): number {
  let depth = 0;
  for (let at = from; at < text.length; at++) {
    if (text[at] === '(') depth++;
    if (text[at] !== ')') continue;
    if (depth === 0) return at;
    depth--;
  }
  return -1;
}

/** `[` に対応する `]` の位置。中の `[...]` の入れ子とインラインコードを飛ばす */
function findLabelEnd(text: string, pos: number): number {
  let depth = 0;
  return findOutsideCode(text, pos + 1, (at) => {
    if (text[at] === '[') depth++;
    if (text[at] !== ']') return false;
    if (depth === 0) return true;
    depth--;
    return false;
  });
}

/** `from` から、インラインコードの中を飛ばしながら `found` が真になる位置を探す。無ければ -1 */
function findOutsideCode(text: string, from: number, found: (at: number) => boolean): number {
  let at = from;
  while (at < text.length) {
    if (text[at] === '`') {
      at = matchCode(text, at).end;
      continue;
    }
    if (found(at)) return at;
    at++;
  }
  return -1;
}
