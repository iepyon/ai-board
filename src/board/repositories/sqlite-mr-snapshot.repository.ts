import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { CardId, MergeRequestIid } from '../../shared/schemas/common.js';
import { FORGE_KINDS, MR_STATES, type MrSnapshot, type MrState } from '../models/mr-state.js';
import type { MrSnapshotRepository } from './mr-snapshot.repository.js';

// ============================================================
// SQLite による PR の状態の控えのリポジトリ実装
// ============================================================

const MrStateSchema = z.object({
  forge: z.enum(FORGE_KINDS),
  iid: z.number().int().positive(),
  state: z.enum(MR_STATES),
  draft: z.boolean(),
  sourceBranch: z.string(),
  title: z.string(),
  webUrl: z.string(),
  latestNoteAt: z.string().nullable(),
  noteCount: z.number().int().nonnegative(),
  latestCommitAt: z.string().nullable(),
  mergedAt: z.string().nullable(),
  // .optional() にしない。readyAt を持たない古い控えを外し、引き直させる（マージ済みの PR もこれで 1 度だけ引き直す）
  readyAt: z.string().nullable(),
  convertedToDraftAt: z.string().nullable(),
});

/**
 * `mr_snapshots` テーブルを読み書きする。`MrState` は JSON の 1 列に入れる。
 *
 * `MrState` に項目を足すと、古い控えは形が合わなくなる。読むときに検証して外し、
 * 引き直させる（マイグレーションで控えを書き換えない）。
 *
 * 画面へ知らせる `onWrite` は持たない。状態の変化はポーラーの `onUpdate` が知らせる。
 */
export class SqliteMrSnapshotRepository implements MrSnapshotRepository {
  constructor(private readonly db: DatabaseSync) {}

  findAll(): Promise<Map<CardId, MrSnapshot>> {
    const rows = this.db.prepare('SELECT card_id, fingerprint, mr FROM mr_snapshots').all();
    const snapshots = new Map<CardId, MrSnapshot>();

    for (const row of rows) {
      const snapshot = toSnapshot(row['fingerprint'], row['mr']);
      if (snapshot !== null) {
        snapshots.set(row['card_id'] as CardId, snapshot);
      }
    }

    return Promise.resolve(snapshots);
  }

  save(cardId: CardId, snapshot: MrSnapshot): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO mr_snapshots (card_id, fingerprint, mr) VALUES (?, ?, ?)
         ON CONFLICT (card_id) DO UPDATE SET fingerprint = excluded.fingerprint, mr = excluded.mr`
      )
      .run(cardId, snapshot.fingerprint, JSON.stringify(snapshot.mr));

    return Promise.resolve();
  }

  delete(cardId: CardId): Promise<void> {
    this.db.prepare('DELETE FROM mr_snapshots WHERE card_id = ?').run(cardId);

    return Promise.resolve();
  }
}

function toSnapshot(fingerprint: unknown, raw: unknown): MrSnapshot | null {
  if (typeof fingerprint !== 'string' || typeof raw !== 'string') return null;

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }

  const parsed = MrStateSchema.safeParse(json);
  if (!parsed.success) return null;

  const mr: MrState = { ...parsed.data, iid: parsed.data.iid as MergeRequestIid };

  return { mr, fingerprint };
}
