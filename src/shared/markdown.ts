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

/** 箇条書き。項目の 2 行目以降（続きの行）も行のまま持ち、深くインデントされた項目は子の箇条書きにする */
export interface ListBlock {
  readonly type: 'list';
  readonly ordered: boolean;
  readonly items: readonly ListItem[];
}

export interface ListItem {
  readonly lines: readonly string[];
  readonly children: readonly ListBlock[];
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
const ROW = /^[ \t]*\|/;

const TAB_WIDTH = 4;

interface Cursor {
  readonly lines: readonly string[];
  pos: number;
}

interface FenceLine {
  readonly fence: string;
  readonly info: string;
}

interface ItemLine {
  readonly indent: number;
  readonly ordered: boolean;
  readonly text: string;
}

interface MutableItem {
  readonly lines: string[];
  readonly children: ListBlock[];
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
    const line = current(cursor);
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

  return { fence, info };
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

  return { type: 'list', ordered: first.ordered, items };
}

/** 箇条書きの 1 歩。読み進めたら true、箇条書きが終わったら false（行は進めない） */
function stepList(cursor: Cursor, first: ItemLine, items: MutableItem[]): boolean {
  const line = current(cursor);
  const item = matchItem(line);
  const last = items.at(-1);

  if (item !== null) return stepItem(cursor, first, item, items);
  if (isBlank(line)) return skipBlankInList(cursor, first.indent);
  if (last === undefined) return false;

  if (indentOf(line) > first.indent || !startsBlock(line)) {
    last.lines.push(line.trim());
    cursor.pos++;
    return true;
  }

  return false;
}

function stepItem(cursor: Cursor, first: ItemLine, item: ItemLine, items: MutableItem[]): boolean {
  const last = items.at(-1);

  if (item.indent > first.indent && last !== undefined) {
    last.children.push(readList(cursor, item));
    return true;
  }
  if (item.indent !== first.indent || item.ordered !== first.ordered) return false;

  items.push({ lines: [item.text], children: [] });
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
  const match = LIST_ITEM.exec(line);
  if (match === null) return null;

  const marker = match[2] ?? '-';
  return {
    indent: indentOf(match[1] ?? ''),
    ordered: /^\d/.test(marker),
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

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function current(cursor: Cursor): string {
  return cursor.lines[cursor.pos] ?? '';
}
