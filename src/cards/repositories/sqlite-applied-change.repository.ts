import type { DatabaseSync } from 'node:sqlite';
import type { AppliedChangeRepository } from './applied-change.repository.js';

// ============================================================
// SQLite による適用済みの変更ファイルのリポジトリ実装
// ============================================================

export class SqliteAppliedChangeRepository implements AppliedChangeRepository {
  constructor(private readonly db: DatabaseSync) {}

  names(): Promise<Set<string>> {
    const rows = this.db.prepare('SELECT name FROM applied_changes').all();

    return Promise.resolve(new Set(rows.map((row) => String(row['name']))));
  }

  record(names: readonly string[], at: Date): Promise<void> {
    const insert = this.db.prepare(
      'INSERT INTO applied_changes (name, applied_at) VALUES (?, ?) ON CONFLICT (name) DO NOTHING'
    );
    for (const name of names) {
      insert.run(name, at.toISOString());
    }

    return Promise.resolve();
  }

  /**
   * 同じ接続の書き込みは、このトランザクションに入る。
   * `fn` の中で本物の I/O を待つと、その間にサーバの別の書き込みが紛れ込みうるので、
   * ファイルの読み込みは `fn` の外で済ませておく。
   */
  async transaction<T>(fn: () => Promise<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = await fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
