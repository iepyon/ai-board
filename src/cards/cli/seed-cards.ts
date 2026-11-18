import matter from 'gray-matter';
import { err, ok, type Result } from '../../shared/result.js';
import { CardIdSchema, type CardId } from '../../shared/schemas/common.js';
import { CardFrontmatterSchema } from '../models/schemas/card.schema.js';
import { normalizeBody } from '../repositories/card-markdown.js';
import type { Card } from '../models/card.js';
import { isAborted, parseReviewLog, stripReviewSection } from '../services/review-log.js';

// ============================================================
// ai-board card seed / export — 題材のファイルとカードの行き来
// ============================================================

/** 題材のディレクトリの `*.md` の 1 ファイル。`name` はディレクトリからの名前（例: `status-stage-counts.md`） */
export interface SeedFile {
  readonly name: string;
  readonly content: string;
}

/** 起票するカードの候補。`card create` に渡す値だけを持つ */
export interface SeedCard {
  readonly file: string;
  readonly id: CardId;
  readonly title: string;
  readonly body: string;
}

/** 読めなかったファイルと、その理由 */
export interface SeedProblem {
  readonly file: string;
  readonly reason: string;
}

const MARKDOWN_EXTENSION = '.md';

/** 題材のディレクトリで、起票する順を 1 行 1 ID で書くファイル（`*.md` ではないので題材としては読まない） */
export const SEED_ORDER_FILE = 'order.txt';

/** 起票する順のファイルを ID の並びにする。空行と `#` で始まる行は読み飛ばす */
export function parseSeedOrder(text: string): readonly string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * 題材のファイルを読み、起票するカードの候補を起票する順に返す。
 *
 * - 起票する順は `order`（`SEED_ORDER_FILE` の ID の並び）に書いた ID が先にその順で、書いていない題材はその後にファイル名の順で続く。
 *   アイデアは起票の時刻の順に並ぶので（`rank` を書かない）、この順がそのままアイデアの並びになる
 * - 読むのは frontmatter の `id` と `title` と本文だけ。`id` は省けばファイル名から補い、
 *   書いてあればファイル名と一致しなければならない（`parseCard` と同じ決まり）。`title` は省けない
 *   （`parseCard` はファイル名で補うが、題材では書き忘れとして拒む）
 * - `rank`・`startedAt`・`skipGates`・`branch`・`pr`・`created` などは書いてあっても読まない。
 *   着手は人が決め、起票の時刻は取り込んだ時刻にする
 * - 1 つでも読めないファイルがあれば、読めないファイルを理由付きで全部返す（呼び出し側は 1 枚も起票しない）。
 *   `order` に題材の無い ID や同じ ID が 2 度あるときも、`SEED_ORDER_FILE` の問題として返す
 *
 * 本文の `## レビュー` の判断はここでは見ない。新しいカードの本文に判断があれば、
 * 起票の口（`createCardCommand` → `planCardWrite`）が書かずに拒む。
 */
export function readSeedCards(
  files: readonly SeedFile[],
  order: readonly string[] = []
): Result<readonly SeedCard[], readonly SeedProblem[]> {
  const cards: SeedCard[] = [];
  const problems: SeedProblem[] = [];

  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  for (const file of sorted) {
    const read = readSeedCard(file);
    if (read.ok) {
      cards.push(read.value);
    } else {
      problems.push({ file: file.name, reason: read.error });
    }
  }

  const ordered = orderSeedCards(cards, order, sorted);
  problems.push(...ordered.problems);

  return problems.length === 0 ? ok(ordered.cards) : err(problems);
}

/**
 * `order` に書いた ID を先にその順で、残りを元の順（ファイル名の順）で並べる。
 * 題材の有無は読めたかどうかによらずファイル名で見る（読めない題材は別の問題として返るので、ここで二重に出さない）
 */
function orderSeedCards(
  cards: readonly SeedCard[],
  order: readonly string[],
  files: readonly SeedFile[]
): { cards: readonly SeedCard[]; problems: readonly SeedProblem[] } {
  const problems: SeedProblem[] = [];
  const fileIds = new Set(files.map((file) => file.name.slice(0, -MARKDOWN_EXTENSION.length)));
  const byId = new Map(cards.map((card) => [card.id as string, card]));
  const seen = new Set<string>();
  const head: SeedCard[] = [];

  for (const id of order) {
    if (seen.has(id)) {
      problems.push({ file: SEED_ORDER_FILE, reason: `${id} が 2 度書いてあります` });
      continue;
    }
    seen.add(id);
    if (!fileIds.has(id)) {
      problems.push({ file: SEED_ORDER_FILE, reason: `${id}.md がありません` });
      continue;
    }
    const card = byId.get(id);
    if (card !== undefined) head.push(card);
  }

  return { cards: [...head, ...cards.filter((card) => !seen.has(card.id))], problems };
}

function readSeedCard(file: SeedFile): Result<SeedCard, string> {
  const fileId = file.name.slice(0, -MARKDOWN_EXTENSION.length);

  let parsed: matter.GrayMatterFile<string>;
  try {
    // options を渡すと gray-matter は同じ文字列の結果を使い回さない（壊れた frontmatter の例外も毎回出る）
    parsed = matter(file.content, {});
  } catch (error) {
    return err(
      `frontmatter を読めません（${error instanceof Error ? error.message : String(error)}）`
    );
  }

  const data = parsed.data as Record<string, unknown>;

  const title = CardFrontmatterSchema.shape.title.safeParse(data['title']);
  if (!title.success) {
    return err('title がありません（1〜200 文字の文字列で書いてください）');
  }

  const rawId = data['id'] ?? fileId;
  const id = CardIdSchema.safeParse(rawId);
  if (!id.success) {
    return err(
      `ID が不正です: ${String(rawId)}（${id.error.issues.map((i) => i.message).join(', ')}）`
    );
  }
  if (id.data !== fileId) {
    return err(`frontmatter の id (${id.data}) がファイル名 (${fileId}) と一致しません`);
  }

  return ok({
    file: file.name,
    id: id.data as CardId,
    title: title.data,
    body: normalizeBody(parsed.content),
  });
}

// ============================================================
// ai-board card export — カードを seed が読む形のファイルにする
// ============================================================

/**
 * 書き出すカードを rank 順のまま選ぶ。
 *
 * 中止のカードは書き出さない（移した先でアイデアに戻っても使い道が無い）。
 * 既定では着手していないカードだけを書き出す。着手済みのカードは
 * ブランチ・計画・PR が元のリポジトリにあり、移した先ではアイデアに戻るので、`includeStarted` のときだけ足す。
 * `startedAt` が無くてもブランチか PR があるカードは着手済みとして扱う
 * （`startedAt` が入る前にマージしたカードがあり、アイデアとして配ると PR の無いアイデアに見えてしまう）
 */
export function selectExportCards(
  cards: readonly Card[],
  options: { readonly includeStarted: boolean }
): readonly Card[] {
  return cards.filter(
    (card) =>
      !isAborted(parseReviewLog(card.body)) && (options.includeStarted || !isStartedCard(card))
  );
}

function isStartedCard(card: Card): boolean {
  return card.startedAt !== null || card.branch !== null || card.pr !== null;
}

/**
 * カードを `seed` が読む形の 1 ファイルにする。名前は `<id>.md`。
 *
 * frontmatter は `id` と `title` だけを書く（`seed` が読むのはこの 2 つと本文だけなので、
 * 着手やブランチや PR 番号が移ると誤解させない）。本文から `## レビュー` の節は除く。
 * 判断は元のリポジトリでの記録で、残すと起票の口（`createCardCommand`）が拒む。
 */
export function toSeedFile(card: Card): SeedFile {
  const body = stripReviewSection(card.body);
  return {
    name: `${card.id}${MARKDOWN_EXTENSION}`,
    content: matter.stringify(body === '' ? '' : `\n${body}\n`, { id: card.id, title: card.title }),
  };
}
