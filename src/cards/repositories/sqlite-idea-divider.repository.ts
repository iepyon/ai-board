import type { DatabaseSync } from 'node:sqlite';
import type { IdeaDividerRepository } from './idea-divider.repository.js';

// ============================================================
// SQLite による区切り線リポジトリ実装
// ============================================================

/**
 * `idea_divider` テーブルの 1 行を読み書きする。
 *
 * `onWrite` の役割は `SqliteCardRepository` と同じ（自分の接続の書き込みを SSE へ知らせる）。
 */
export class SqliteIdeaDividerRepository implements IdeaDividerRepository {
  constructor(
    private readonly db: DatabaseSync,
    private readonly onWrite: () => void = () => undefined
  ) {}

  get(): Promise<number | null> {
    const row = this.db.prepare('SELECT rank FROM idea_divider WHERE id = 1').get();
    const rank = row?.['rank'];

    return Promise.resolve(typeof rank === 'number' ? rank : null);
  }

  set(rank: number): Promise<void> {
    this.db
      .prepare(
        'INSERT INTO idea_divider (id, rank) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET rank = excluded.rank'
      )
      .run(rank);
    this.onWrite();

    return Promise.resolve();
  }
}
