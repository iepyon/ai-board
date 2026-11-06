// ============================================================
// 計画ファイルのタスクの行
// ============================================================

/**
 * タスクのチェックボックス行。
 *
 * 計画の進捗（`plan.repository.ts` の `countTasks`）と、実装中の段の判定の
 * 両方が同じ数え方をするよう、ここに 1 つだけ置く。
 *
 * 先頭の空白を許すのは、インデントされたサブタスクを親と同じように数えるため
 * （列 0 に固定すると `  - [ ] 1.1.1 …` が進捗から消える）。
 * 箇条点とブラケットの間も `\s*` で、`-[ ]` のような詰めた書き方も拾う。
 * 狭めると数えていた行が落ちるだけなので、意図的に緩くしてある。
 */
export const TASK_PATTERN = /^\s*[-*]\s*\[[\sx]\]/i;

/** 倒れた（`[x]` / `[X]`）タスクの行 */
export const COMPLETED_TASK_PATTERN = /^\s*[-*]\s*\[x\]/i;

/** 開くフェンス（字下げは問わない）。後ろに言語名などがあってよい */
const OPENING_FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/;

/** 閉じるフェンス（字下げは問わない）。フェンスの文字の連なりだけの行 */
const CLOSING_FENCE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

/**
 * 本文の行のうち、フェンスで囲んだコードブロックの外にあるものだけを返す。
 *
 * 計画に書いたチェックボックスの例（`## AI レビュー` 節の書き方など）を、
 * 進捗や段の判定がタスクとして数えないようにするため、タスクを数える前にこれを通す。
 *
 * 見分け方は、GitHub などの Markdown の描き手がフェンスを読む形にそろえる。
 *
 * - 開くフェンスは ` ``` ` か `~~~`（3 文字以上）で始まる行。後ろに言語名などがあってよい。
 *   バッククォートのフェンスで、後ろにバッククォートを含むものはフェンスではない（インラインコード）
 * - 閉じるフェンスは、開いたものと同じ文字で、同じ長さ以上の連なりだけの行。
 *   ` ``` ` で開いた範囲を `~~~` では閉じず、` ```` ` で開いた範囲を ` ``` ` では閉じない
 * - フェンスの行そのものも外す
 * - 字下げの深さは問わない（箇条書きの中に字下げして書いたフェンスも拾う）
 *
 * 描き手と食い違わせている点が 2 つある。
 *
 * - **閉じていないフェンスは、無かったものとする。** 描き手は本文の終わりまでをコードとするが、
 *   ここでそうすると、フェンスの書き損じ 1 つで後ろのタスクがすべて消え、進捗が 100% になり、
 *   段の判定が未着手のタスクを残したまま先へ進んでしまう。数えすぎて止まるほうが気づきやすい
 * - **4 つの空白で字下げしたコードブロックは扱わない。** 字下げしたサブタスク（`    - [ ] …`）を
 *   親と同じく数えており、字下げのコードブロックを外すとそれが消える
 */
export function linesOutsideCodeBlocks(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const outside: string[] = [];

  let pos = 0;
  while (pos < lines.length) {
    const line = lines[pos] ?? '';
    const fence = openingFence(line);
    const close = fence === null ? -1 : findClosingFence(lines, pos + 1, fence);
    if (close === -1) {
      outside.push(line);
      pos++;
    } else {
      pos = close + 1;
    }
  }

  return outside;
}

/** 開くフェンスの文字の連なり。フェンスでなければ null */
function openingFence(line: string): string | null {
  const match = OPENING_FENCE.exec(line);
  if (match === null) return null;

  const fence = match[1] ?? '```';
  const info = match[2] ?? '';
  if (fence.startsWith('`') && info.includes('`')) return null;

  return fence;
}

/** `from` から後ろで、`fence` を閉じる行の位置。無ければ -1 */
function findClosingFence(lines: readonly string[], from: number, fence: string): number {
  for (let pos = from; pos < lines.length; pos++) {
    const close = CLOSING_FENCE.exec(lines[pos] ?? '')?.[1];
    if (close !== undefined && close[0] === fence[0] && close.length >= fence.length) return pos;
  }
  return -1;
}
