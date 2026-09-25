import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import matter from 'gray-matter';
import type { CardId, MergeRequestIid } from '../../shared/schemas/common.js';
import { CardIdSchema } from '../../shared/schemas/common.js';
import { CardFrontmatterSchema } from '../models/schemas/card.schema.js';
import type { Card } from '../models/card.js';
import type { CardRepository } from './card.repository.js';

// ============================================================
// Markdown ファイルによるカードリポジトリ実装
// ============================================================

const CARD_EXTENSION = '.md';

/**
 * `.ai-board/cards/<id>.md` を読み書きする。
 *
 * 書き込みは常にこのディレクトリ配下に限られる（`.ai-board/plans/` には一切触れない）。
 */
export class FsCardRepository implements CardRepository {
  constructor(private readonly cardsDir: string) {}

  async findAll(): Promise<Card[]> {
    const files = await this.listCardFiles();

    const cards = await Promise.all(files.map((file) => this.readCardFile(file)));

    return cards
      .filter((card): card is Card => card !== null)
      .sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
  }

  async findById(id: CardId): Promise<Card | null> {
    return this.readCardFile(this.filePathFor(id));
  }

  async create(card: Card): Promise<boolean> {
    await fs.mkdir(this.cardsDir, { recursive: true });
    const filePath = this.filePathFor(card.id);

    try {
      // wx は既存ファイルがあれば EEXIST で失敗する（チェックと書き込みの競合を避ける）
      await fs.writeFile(filePath, serializeCard(card), { encoding: 'utf-8', flag: 'wx' });
      return true;
    } catch (error) {
      if (isErrnoException(error) && error.code === 'EEXIST') {
        return false;
      }
      throw error;
    }
  }

  async save(card: Card): Promise<boolean> {
    const filePath = this.filePathFor(card.id);

    if (!(await exists(filePath))) {
      return false;
    }

    await fs.writeFile(filePath, serializeCard(card), 'utf-8');
    return true;
  }

  private filePathFor(id: CardId): string {
    // id は kebab-case として検証済みなので、パストラバーサルは起こり得ない
    return path.join(this.cardsDir, `${id}${CARD_EXTENSION}`);
  }

  private async listCardFiles(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.cardsDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(CARD_EXTENSION))
        .map((entry) => path.join(this.cardsDir, entry.name));
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /** 壊れたファイルは警告して null を返す（ボード全体を落とさない） */
  private async readCardFile(filePath: string): Promise<Card | null> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if (isErrnoException(error) && error.code === 'ENOENT') {
        return null;
      }
      throw error;
    }

    return parseCard(filePath, raw);
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

  const data = parsed.data as Record<string, unknown>;
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
    // 前後の改行は正規化する。これで読み書きを往復しても本文が育たない
    body: parsed.content.replace(/^\n+/, '').replace(/\n+$/, ''),
  };
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
  };

  const body = card.body.endsWith('\n') || card.body === '' ? card.body : `${card.body}\n`;

  return matter.stringify(`\n${body}`, frontmatter);
}

/** ファイル名として使える kebab-case か */
export function isValidCardId(raw: string): boolean {
  return CardIdSchema.safeParse(raw).success;
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
