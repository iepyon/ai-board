import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { CardId, MergeRequestIid } from '../../shared/schemas/common.js';
import { CardFrontmatterSchema } from '../models/schemas/card.schema.js';
import type { Card } from '../models/card.js';
import type { CardRepository } from './card.repository.js';
import { compareCards } from '../services/card-order.js';

// ============================================================
// SQLite によるカードリポジトリ実装
// ============================================================

const COLUMNS = 'id, title, created, started_at, skip_gates, branch, mr, rank, body';

const VALUES = ':id, :title, :created, :startedAt, :skipGates, :branch, :mr, :rank, :body';

/**
 * `.ai-board/board.db` の `cards` テーブルを読み書きする。
 *
 * `onWrite` は書き込みがコミットされた後に呼ばれる。自分の接続の書き込みは
 * `watchDatabase` の `data_version` に現れないため、SSE への通知はここから出す。
 */
export class SqliteCardRepository implements CardRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly onWrite: () => void = () => undefined
  ) {}

  findAll(): Promise<Card[]> {
    const rows = this.db.prepare(`SELECT ${COLUMNS} FROM cards`).all();

    const cards = rows.map(toCard).filter((card): card is Card => card !== null);

    return Promise.resolve(cards.sort(compareCards));
  }

  findById(id: CardId): Promise<Card | null> {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM cards WHERE id = ?`).get(id);

    return Promise.resolve(row === undefined ? null : toCard(row));
  }

  create(card: Card): Promise<boolean> {
    // 主キーの衝突は INSERT 自体に判定させる（存在確認と書き込みの競合を避ける）
    const result = this.db
      .prepare(`INSERT INTO cards (${COLUMNS}) VALUES (${VALUES}) ON CONFLICT (id) DO NOTHING`)
      .run(toParams(card));

    return Promise.resolve(this.notifyIfChanged(result.changes));
  }

  save(card: Card): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE cards SET
           title = :title, created = :created, started_at = :startedAt,
           skip_gates = :skipGates, branch = :branch, mr = :mr,
           rank = :rank, body = :body
         WHERE id = :id`
      )
      .run(toParams(card));

    return Promise.resolve(this.notifyIfChanged(result.changes));
  }

  private notifyIfChanged(changes: number | bigint): boolean {
    const changed = Number(changes) > 0;
    if (changed) {
      this.onWrite();
    }
    return changed;
  }
}

// ============================================================
// 行 ⇄ Card
// ============================================================

function toParams(card: Card): Record<string, SQLInputValue> {
  return {
    id: card.id,
    title: card.title,
    created: card.created,
    startedAt: card.startedAt,
    skipGates: JSON.stringify(card.skipGates),
    branch: card.branch,
    mr: card.mr,
    rank: card.rank,
    body: card.body,
  };
}

/**
 * 行を Card に戻す。
 *
 * 書き手はこのリポジトリだけだが、DB は手で触れるファイルでもある。
 * 規定外の値を持つ行は警告して読み飛ばす（1 行でボード全体を 500 にしない）。
 */
function toCard(row: Record<string, unknown>): Card | null {
  const result = CardFrontmatterSchema.safeParse({
    id: row['id'],
    title: row['title'],
    created: row['created'],
    startedAt: row['started_at'],
    skipGates: parseJsonArray(row['skip_gates']),
    branch: row['branch'],
    mr: row['mr'],
    rank: row['rank'],
  });

  if (!result.success || typeof row['body'] !== 'string') {
    const reason = result.success
      ? 'body が文字列ではありません'
      : result.error.issues.map((issue) => issue.message).join(', ');
    console.warn(`[ai-board] カードを読み飛ばしました: ${String(row['id'])} — ${reason}`);
    return null;
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

function parseJsonArray(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}
