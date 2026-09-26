import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';
import type { CardId, MergeRequestIid } from '../../shared/schemas/common.js';
import { CardFrontmatterSchema } from '../models/schemas/card.schema.js';
import type { Card } from '../models/card.js';
import { compareCards } from '../services/card-order.js';

// ============================================================
// カードの Markdown 表現
// ============================================================

const CARD_EXTENSION = '.md';

/**
 * カードの正本は SQLite にある。Markdown 表現は次の 2 か所でだけ使う。
 *
 * - 移行前の `.ai-board/cards/<id>.md` の取り込み（`ai-board import`）
 * - `ai-board card show` の出力（エージェントが読む形を移行前と揃える）
 *
 * ここから `.ai-board/` へ書き込むことは無い。
 */
export async function readCardFiles(cardsDir: string): Promise<Card[]> {
  const files = await listCardFiles(cardsDir);

  const cards = await Promise.all(
    files.map(async (file) => parseCard(file, await fs.readFile(file, 'utf-8')))
  );

  return cards.filter((card): card is Card => card !== null).sort(compareCards);
}

async function listCardFiles(cardsDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(cardsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(CARD_EXTENSION))
      .map((entry) => path.join(cardsDir, entry.name));
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

// ============================================================
// シリアライズ / パース
// ============================================================

/**
 * Markdown を Card に変換する。
 *
 * frontmatter に id が無い場合はファイル名から補う。手で書いたカードでも
 * そのまま読めるようにするため。
 */
export function parseCard(filePath: string, raw: string): Card | null {
  const fileId = path.basename(filePath, CARD_EXTENSION);

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (error) {
    warnMalformed(filePath, error instanceof Error ? error.message : String(error));
    return null;
  }

  const data = dropGitLabMr(parsed.data as Record<string, unknown>);
  const candidate = {
    ...data,
    id: data['id'] ?? fileId,
    title: data['title'] ?? fileId,
    created: data['created'] ?? new Date(0).toISOString(),
  };

  const result = CardFrontmatterSchema.safeParse(candidate);
  if (!result.success) {
    warnMalformed(filePath, result.error.issues.map((issue) => issue.message).join(', '));
    return null;
  }

  const frontmatter = result.data;

  // ファイル名と frontmatter の id が食い違うカードは、どちらを正とするか
  // 決められないため読み込まない（黙って片方を採用すると紐付けが壊れる）
  if (frontmatter.id !== fileId) {
    warnMalformed(
      filePath,
      `frontmatter の id (${frontmatter.id}) がファイル名 (${fileId}) と一致しません`
    );
    return null;
  }

  return {
    id: frontmatter.id as CardId,
    title: frontmatter.title,
    created: frontmatter.created,
    startedAt: frontmatter.startedAt,
    skipGates: frontmatter.skipGates,
    branch: frontmatter.branch,
    mr: frontmatter.mr as MergeRequestIid | null,
    forge: frontmatter.forge,
    rank: frontmatter.rank,
    // 前後の改行は正規化する。これで読み書きを往復しても本文が育たない
    body: parsed.content.replace(/^\n+/, '').replace(/\n+$/, ''),
  };
}

/**
 * GitLab 連携を廃止する前のカードは `forge: gitlab` と MR 番号を持っている。
 * その番号を GitHub の PR 番号として引かないよう、番号ごと捨てて branch から解決し直させる。
 */
function dropGitLabMr(data: Record<string, unknown>): Record<string, unknown> {
  if (data['forge'] !== 'gitlab') return data;

  return { ...data, mr: null, forge: null };
}

/** Card を Markdown 文字列に戻す。frontmatter のキー順は安定させる */
export function serializeCard(card: Card): string {
  const frontmatter = {
    id: card.id,
    title: card.title,
    created: card.created,
    startedAt: card.startedAt,
    skipGates: card.skipGates,
    branch: card.branch,
    mr: card.mr,
    forge: card.forge,
    // 並べ替えたことの無いカードに null の行を足さない（保存し直しても差分を生まない）
    ...(card.rank === null ? {} : { rank: card.rank }),
  };

  const body = card.body.endsWith('\n') || card.body === '' ? card.body : `${card.body}\n`;

  return matter.stringify(`\n${body}`, frontmatter);
}

// ============================================================
// ヘルパー
// ============================================================

function warnMalformed(filePath: string, reason: string): void {
  console.warn(`[ai-board] カードファイルを読み飛ばしました: ${filePath} — ${reason}`);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
