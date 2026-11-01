import * as fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { err, ok, type Result } from '../shared/result.js';
import type { CardId, MergeRequestIid } from '../shared/schemas/common.js';
import { CardFrontmatterSchema } from '../cards/models/schemas/card.schema.js';
import type { Card } from '../cards/models/card.js';
import type { MrSnapshot } from '../board/models/mr-state.js';
import { parseMrSnapshot } from '../board/repositories/file-mr-snapshot.repository.js';

// ============================================================
// 移行前のカードの保存先 — SQLite の読み出しだけ
// ============================================================

/**
 * 読める DB のスキーマの版（`PRAGMA user_version`）。
 *
 * カードの正本はデータ用ブランチに移った。ここは `ai-board migrate` が移行前の `board.db` を読むためだけに残す。
 * 最後の版（`cards` / `idea_divider` / `mr_snapshots` の 3 つの表があり、GitLab の番号を消した後）だけを読む。
 * それより古い DB は、GitLab の MR 番号を PR 番号として持ち込みうるので読まない。
 */
export const LEGACY_SCHEMA_VERSION = 5;

/** 移行前の DB の中身 */
export interface LegacyBoard {
  /** すべてのカード。本文には `## レビュー` の節がそのまま入っている */
  readonly cards: readonly Card[];
  /** アイデアの表の区切り線。一度も動かしていなければ null */
  readonly divider: number | null;
  /** PR の状態の控え。形の合わない古い控えは外してある */
  readonly mrSnapshots: ReadonlyMap<CardId, MrSnapshot>;
}

export type LegacyDatabaseError =
  /** 指定した場所に DB が無い */
  | { readonly type: 'LegacyDatabaseMissing'; readonly dbPath: string }
  /** DB を開けない・版が違う・読めない行がある */
  | { readonly type: 'LegacyDatabaseUnreadable'; readonly dbPath: string; readonly reason: string };

const CARD_COLUMNS = 'id, title, created, started_at, skip_gates, branch, mr, rank, body';

/**
 * 移行前の DB を読み出し専用で開き、中身をすべて読む。
 *
 * 読み出し専用で開くのは、移行元のファイルを変えないためである（普通に開くと、無いファイルは空の DB として
 * 作られ、WAL の設定などが書き込まれる）。
 * 規定外の値を持つ行が 1 つでもあれば失敗にする。読み飛ばすと、そのカードは移行の後に黙って消える。
 */
export function readLegacyBoard(dbPath: string): Result<LegacyBoard, LegacyDatabaseError> {
  if (!fs.existsSync(dbPath)) return err({ type: 'LegacyDatabaseMissing', dbPath });

  const unreadable = (reason: string): Result<never, LegacyDatabaseError> =>
    err({ type: 'LegacyDatabaseUnreadable', dbPath, reason });

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    return unreadable(errorMessage(error));
  }

  try {
    const version = readUserVersion(db);
    if (version !== LEGACY_SCHEMA_VERSION) {
      return unreadable(
        `スキーマの版が v${version} です（読めるのは v${LEGACY_SCHEMA_VERSION} だけです）`
      );
    }

    const cards: Card[] = [];
    const invalid: string[] = [];
    for (const row of db.prepare(`SELECT ${CARD_COLUMNS} FROM cards ORDER BY id`).all()) {
      const card = toCard(row);
      if (typeof card === 'string') invalid.push(card);
      else cards.push(card);
    }
    if (invalid.length > 0) {
      return unreadable(`読めない行があります: ${invalid.join(' / ')}`);
    }

    return ok({ cards, divider: readDivider(db), mrSnapshots: readMrSnapshots(db) });
  } catch (error) {
    return unreadable(errorMessage(error));
  } finally {
    db.close();
  }
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as Record<string, unknown> | undefined;
  const value = row?.['user_version'];

  return typeof value === 'number' ? value : 0;
}

function readDivider(db: DatabaseSync): number | null {
  const rank = db.prepare('SELECT rank FROM idea_divider WHERE id = 1').get()?.['rank'];

  return typeof rank === 'number' ? rank : null;
}

/** 形の合わない控えは外す。控えは問い合わせを省くためのもので、無くても引き直すだけで済む */
function readMrSnapshots(db: DatabaseSync): Map<CardId, MrSnapshot> {
  const snapshots = new Map<CardId, MrSnapshot>();

  for (const row of db.prepare('SELECT card_id, fingerprint, mr FROM mr_snapshots').all()) {
    const cardId = row['card_id'];
    const raw = row['mr'];
    if (typeof cardId !== 'string' || typeof raw !== 'string') continue;

    const snapshot = parseMrSnapshot({ fingerprint: row['fingerprint'], mr: parseJsonOrNull(raw) });
    if (snapshot !== null) snapshots.set(cardId as CardId, snapshot);
  }

  return snapshots;
}

/** 行を Card に戻す。規定外の値なら、どの行の何が悪いかの文を返す */
function toCard(row: Record<string, unknown>): Card | string {
  const result = CardFrontmatterSchema.safeParse({
    id: row['id'],
    title: row['title'],
    created: row['created'],
    startedAt: row['started_at'],
    skipGates: parseJsonOrRaw(row['skip_gates']),
    branch: row['branch'],
    mr: row['mr'],
    rank: row['rank'],
  });

  if (!result.success) {
    return `${String(row['id'])}（${result.error.issues.map((issue) => issue.message).join(', ')}）`;
  }
  if (typeof row['body'] !== 'string') {
    return `${String(row['id'])}（body が文字列ではありません）`;
  }

  const fields = result.data;

  return {
    id: fields.id as CardId,
    title: fields.title,
    created: fields.created,
    startedAt: fields.startedAt,
    skipGates: fields.skipGates,
    branch: fields.branch,
    mr: fields.mr as MergeRequestIid | null,
    rank: fields.rank,
    body: row['body'],
  };
}

function parseJsonOrRaw(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function parseJsonOrNull(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
