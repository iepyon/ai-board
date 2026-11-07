import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { isErr, ok } from '../../shared/result.js';
import { CardIdSchema, type CardId, type MergeRequestIid } from '../../shared/schemas/common.js';
import type { DataStore, DataStoreError } from '../../infrastructure/data-store.js';
import { FORGE_KINDS, MR_STATES, type MrSnapshot, type MrState } from '../models/mr-state.js';
import type { MrSnapshotRepository } from './mr-snapshot.repository.js';

// ============================================================
// データ用ブランチと使い捨ての JSON による PR の状態の控えのリポジトリ実装
// ============================================================

/** マージ済みの PR の控えを置く、データ用ブランチの中のディレクトリ */
export const SNAPSHOTS_DIR = 'snapshots';

/** 開いている PR の控えを置く、git に載せないファイル（データのワークツリーの親からの相対） */
export const MR_SNAPSHOT_CACHE_FILE = path.join('cache', 'mr-snapshots.json');

/** マージ済みの PR の控えのファイル名 */
export function snapshotFileName(cardId: CardId): string {
  return `${cardId}.json`;
}

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
  // 足す前の控えは null で読む。開いている PR は指紋の版を上げたので引き直され、マージ済みの PR では使わない
  latestAiNoteAt: z.string().nullable().default(null),
  latestCommitAt: z.string().nullable(),
  mergedAt: z.string().nullable(),
  // .optional() にしない。readyAt を持たない古い控えを外し、引き直させる（マージ済みの PR もこれで 1 度だけ引き直す）
  readyAt: z.string().nullable(),
  convertedToDraftAt: z.string().nullable(),
});

const MrSnapshotSchema = z.object({
  fingerprint: z.string(),
  mr: MrStateSchema,
});

/**
 * JSON から読んだ値を控えにする。形が合わなければ null。
 *
 * `MrState` に項目を足すと、古い控えは形が合わなくなる。外して引き直させる（控えを書き換えない）。
 */
export function parseMrSnapshot(json: unknown): MrSnapshot | null {
  const parsed = MrSnapshotSchema.safeParse(json);
  if (!parsed.success) return null;

  const mr: MrState = { ...parsed.data.mr, iid: parsed.data.mr.iid as MergeRequestIid };
  return { mr, fingerprint: parsed.data.fingerprint };
}

/**
 * マージ済みの PR の控えのファイルの中身。
 *
 * 項目の順をスキーマで決める。2 つの clone が同じ PR を書いたとき、同じバイト列にして余計なコミットを作らない。
 */
export function serializeMergedSnapshot(snapshot: MrSnapshot): string {
  return `${JSON.stringify(MrSnapshotSchema.parse(snapshot), null, 2)}\n`;
}

export interface FileMrSnapshotRepositoryOptions {
  /** 開いている PR の控えのファイル。既定は `<dataDir の親>/cache/mr-snapshots.json` */
  readonly cacheFile?: string;
}

/**
 * PR の状態の控えを、2 か所に分けて置く。
 *
 * - マージ済みの PR は、データ用ブランチの `snapshots/<id>.json` に置く（`DataStore.transact` を通す）。
 *   二度と変わらないので、全員で 1 度引けば足りる。クラウドの新しい clone でも引き直さずに済む
 * - それ以外は、git に載せない使い捨ての `<dataDir の親>/cache/mr-snapshots.json` に置く。
 *   データのワークツリーの外なので、取り直しの `clean` で消えない。クラウドでは毎回空から始まる
 *
 * 控えはステージの導出の入力ではなく、gh の問い合わせを省くためのものである。
 * データ用ブランチへの書き込みに失敗しても（オフライン、push の拒否、ロックの待ち切れ）、警告するだけで例外を投げない。
 * 投げるとポーラーの接続の状態が error になり、ループが止まる。書けなかった控えは、次のプロセスが引き直して書き直す。
 */
export class FileMrSnapshotRepository implements MrSnapshotRepository {
  private readonly cacheFile: string;

  constructor(
    private readonly store: DataStore,
    options: FileMrSnapshotRepositoryOptions = {}
  ) {
    this.cacheFile =
      options.cacheFile ?? path.join(path.dirname(store.dataDir), MR_SNAPSHOT_CACHE_FILE);
  }

  findAll(): Promise<Map<CardId, MrSnapshot>> {
    return settle(() => {
      const snapshots = new Map(this.readCache());

      // 同じカードが両方にあれば、データ用ブランチのマージ済みを採る。番号が違えばポーラーが引き直す
      for (const [cardId, snapshot] of this.readMerged()) {
        snapshots.set(cardId, snapshot);
      }

      return snapshots;
    });
  }

  /** データ用ブランチのマージ済みの控えだけを読む。使い捨ての控え（`cache/`）は読まない */
  findMerged(): Promise<Map<CardId, MrSnapshot>> {
    return settle(() => this.readMerged());
  }

  async save(cardId: CardId, snapshot: MrSnapshot): Promise<void> {
    if (snapshot.mr.state === 'merged') {
      const written = await this.writeMerged(cardId, snapshot);
      if (written) this.updateCache((cache) => cache.delete(cardId));
      return;
    }

    this.updateCache((cache) => cache.set(cardId, snapshot));
    // 番号を付け替えたカードに前のマージ済みの控えが残っていれば、読むときにそちらが勝ってしまう
    await this.removeMerged(cardId);
  }

  async delete(cardId: CardId): Promise<void> {
    this.updateCache((cache) => cache.delete(cardId));
    await this.removeMerged(cardId);
  }

  /** マージ済みの控えをデータ用ブランチに書く。書けたら true */
  private async writeMerged(cardId: CardId, snapshot: MrSnapshot): Promise<boolean> {
    const content = serializeMergedSnapshot(snapshot);

    const result = await this.store.transact<void, never>(
      `data: ${cardId} のマージ済みの PR の控えを書く`,
      (dataDir) =>
        settle(() => {
          const dir = path.join(dataDir, SNAPSHOTS_DIR);
          fs.mkdirSync(dir, { recursive: true });
          // 中身が同じなら変化が無いので、transact はコミットしない
          fs.writeFileSync(path.join(dir, snapshotFileName(cardId)), content);
          return ok(undefined);
        })
    );

    if (isErr(result)) {
      warnStoreFailure(cardId, 'マージ済みの PR の控えを書けませんでした', result.error);
      return false;
    }
    return true;
  }

  /** データ用ブランチのマージ済みの控えを消す。無ければ transact に入らない（取り直しと push を走らせない） */
  private async removeMerged(cardId: CardId): Promise<void> {
    if (!fs.existsSync(this.mergedFile(this.store.dataDir, cardId))) return;

    const result = await this.store.transact<void, never>(
      `data: ${cardId} のマージ済みの PR の控えを消す`,
      (dataDir) =>
        settle(() => {
          // 取り直した後にはもう無いかもしれない。無ければ何も書かずに終わる
          fs.rmSync(this.mergedFile(dataDir, cardId), { force: true });
          return ok(undefined);
        })
    );

    if (isErr(result)) {
      warnStoreFailure(cardId, 'マージ済みの PR の控えを消せませんでした', result.error);
    }
  }

  private mergedFile(dataDir: string, cardId: CardId): string {
    return path.join(dataDir, SNAPSHOTS_DIR, snapshotFileName(cardId));
  }

  /** データ用ブランチの `snapshots/` を読む。名前が ID として不正なもの、形の合わないものは黙って外す */
  private readMerged(): Map<CardId, MrSnapshot> {
    const dir = path.join(this.store.dataDir, SNAPSHOTS_DIR);
    const snapshots = new Map<CardId, MrSnapshot>();
    if (!fs.existsSync(dir)) return snapshots;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

      const id = entry.name.slice(0, -'.json'.length);
      if (!CardIdSchema.safeParse(id).success) continue;

      const snapshot = parseMrSnapshot(parseJsonOrNull(readFileOrNull(path.join(dir, entry.name))));
      if (snapshot !== null) snapshots.set(id as CardId, snapshot);
    }

    return snapshots;
  }

  /** 使い捨ての控えを読む。無い・壊れている・形の合わない項目は、空とみなして外す */
  private readCache(): Map<CardId, MrSnapshot> {
    const snapshots = new Map<CardId, MrSnapshot>();
    const json = parseJsonOrNull(readFileOrNull(this.cacheFile));
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return snapshots;

    for (const [id, raw] of Object.entries(json as Record<string, unknown>)) {
      if (!CardIdSchema.safeParse(id).success) continue;

      const snapshot = parseMrSnapshot(raw);
      if (snapshot !== null) snapshots.set(id as CardId, snapshot);
    }

    return snapshots;
  }

  /**
   * 使い捨ての控えを読み、変えて、書き戻す。
   *
   * `ai-board` の CLI（`status` と `decide`）のポーラーが同時に書きうるので、一時ファイルに書いてから置き換える
   * （読みかけの壊れたファイルを見せない）。後から書いた方が先の変更を消しうるが、控えなので次の問い合わせで戻る。
   */
  private updateCache(change: (cache: Map<CardId, MrSnapshot>) => unknown): void {
    const cache = this.readCache();
    const before = JSON.stringify(Object.fromEntries(cache));
    change(cache);
    if (JSON.stringify(Object.fromEntries(cache)) === before) return;

    fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
    const tmp = `${this.cacheFile}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(Object.fromEntries(cache), null, 2)}\n`);
    fs.renameSync(tmp, this.cacheFile);
  }
}

// ============================================================
// ヘルパー
// ============================================================

function warnStoreFailure(cardId: CardId, message: string, error: DataStoreError): void {
  console.warn(`[ai-board] ${cardId} の${message}: ${error.type}`);
}

/** 同期の処理を Promise にする。投げた例外は reject として返す */
function settle<T>(fn: () => T): Promise<T> {
  return new Promise((resolve) => resolve(fn()));
}

function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseJsonOrNull(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
