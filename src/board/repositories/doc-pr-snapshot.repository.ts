import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { isErr, ok } from '../../shared/result.js';
import { CardIdSchema, type CardId, type PullRequestNumber } from '../../shared/schemas/common.js';
import type { DocumentStore, StoreError } from '../../infrastructure/document-store.js';
import { readFileOrNull } from '../../infrastructure/read-file.js';
import { settle } from '../../shared/settle.js';
import { FORGE_KINDS, PR_STATES, type PrSnapshot, type PrState } from '../models/pr-state.js';
import type { PrSnapshotRepository } from './pr-snapshot.repository.js';

// ============================================================
// 置き場所の文書と使い捨ての JSON による PR の状態の控えのリポジトリ実装
// ============================================================

/** マージ済みの PR の控えを置く、置き場所のコレクション（ID はカード ID） */
export const SNAPSHOTS_COLLECTION = 'snapshots';
/** 開いている PR の控えを置く、置き場所に送らないファイル（置き場所のディレクトリからの相対） */
export const PR_SNAPSHOT_CACHE_FILE = path.join('cache', 'pr-snapshots.json');

const PrStateSchema = z.object({
  forge: z.enum(FORGE_KINDS),
  number: z.number().int().positive(),
  state: z.enum(PR_STATES),
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

const PrSnapshotSchema = z.object({
  fingerprint: z.string(),
  pr: PrStateSchema,
});

/**
 * JSON から読んだ値を控えにする。形が合わなければ null。
 *
 * `PrState` に項目を足すと、古い控えは形が合わなくなる。外して引き直させる（控えを書き換えない）。
 */
export function parsePrSnapshot(json: unknown): PrSnapshot | null {
  const parsed = PrSnapshotSchema.safeParse(json);
  if (!parsed.success) return null;

  const pr: PrState = { ...parsed.data.pr, number: parsed.data.pr.number as PullRequestNumber };
  return { pr, fingerprint: parsed.data.fingerprint };
}

/** マージ済みの PR の控えの文書の中身。項目の順をスキーマで決める（同じ控えなら同じ中身にして、余計な改訂を作らない） */
export function mergedSnapshotData(snapshot: PrSnapshot): Record<string, unknown> {
  return PrSnapshotSchema.parse(snapshot) as Record<string, unknown>;
}

/**
 * PR の状態の控えを、2 か所に分けて置く。
 *
 * - マージ済みの PR は、置き場所の `snapshots/<id>` の文書に置く（`DocumentStore.transact` を通す）。
 *   二度と変わらないので、全員で 1 度引けば足りる。クラウドの新しいセッションでも引き直さずに済む
 * - それ以外は、置き場所に送らない使い捨ての `<置き場所のディレクトリ>/cache/pr-snapshots.json` に置く。
 *   クラウドでは毎回空から始まる
 *
 * 控えはステージの導出の入力ではなく、gh の問い合わせを省くためのものである。
 * 置き場所への書き込みに失敗しても（ロックの待ち切れ、写しが無い）、警告するだけで例外を投げない。
 * 投げると `PrFetcher` の接続の状態が error になり、ループが止まる。書けなかった控えは、次のプロセスが引き直して書き直す。
 */
export class DocPrSnapshotRepository implements PrSnapshotRepository {
  constructor(
    private readonly store: DocumentStore,
    private readonly cacheFile: string
  ) {}

  findAll(): Promise<Map<CardId, PrSnapshot>> {
    return settle(() => {
      const snapshots = new Map(this.readCache());

      // 同じカードが両方にあれば、置き場所のマージ済みを採る。番号が違えば `PrFetcher` が引き直す
      for (const [cardId, snapshot] of this.readMerged()) {
        snapshots.set(cardId, snapshot);
      }

      return snapshots;
    });
  }

  /** 置き場所のマージ済みの控えだけを読む。使い捨ての控え（`cache/`）は読まない */
  findMerged(): Promise<Map<CardId, PrSnapshot>> {
    return settle(() => this.readMerged());
  }

  async save(cardId: CardId, snapshot: PrSnapshot): Promise<void> {
    if (snapshot.pr.state === 'merged') {
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

  /** マージ済みの控えを置き場所に書く。書けたら true。中身が同じなら書かない */
  private async writeMerged(cardId: CardId, snapshot: PrSnapshot): Promise<boolean> {
    const data = mergedSnapshotData(snapshot);

    const result = await this.store.transact<void, never>(
      `${cardId} のマージ済みの PR の控えを書く`,
      () =>
        settle(() => {
          const current = this.store.get(SNAPSHOTS_COLLECTION, cardId);
          if (current === null || JSON.stringify(current) !== JSON.stringify(data)) {
            this.store.set(SNAPSHOTS_COLLECTION, cardId, data);
          }
          return ok(undefined);
        })
    );

    if (isErr(result)) {
      warnStoreFailure(cardId, 'マージ済みの PR の控えを書けませんでした', result.error);
      return false;
    }
    return true;
  }

  /** 置き場所のマージ済みの控えを消す。無ければ transact に入らない */
  private async removeMerged(cardId: CardId): Promise<void> {
    if (this.store.get(SNAPSHOTS_COLLECTION, cardId) === null) return;

    const result = await this.store.transact<void, never>(
      `${cardId} のマージ済みの PR の控えを消す`,
      () =>
        settle(() => {
          this.store.delete(SNAPSHOTS_COLLECTION, cardId);
          return ok(undefined);
        })
    );

    if (isErr(result)) {
      warnStoreFailure(cardId, 'マージ済みの PR の控えを消せませんでした', result.error);
    }
  }

  /** 置き場所の `snapshots/` を読む。ID として不正なもの、形の合わないものは黙って外す */
  private readMerged(): Map<CardId, PrSnapshot> {
    const snapshots = new Map<CardId, PrSnapshot>();
    for (const doc of this.store.list(SNAPSHOTS_COLLECTION)) {
      if (!CardIdSchema.safeParse(doc.id).success) continue;
      const snapshot = parsePrSnapshot(doc.data);
      if (snapshot !== null) snapshots.set(doc.id as CardId, snapshot);
    }
    return snapshots;
  }

  /** 使い捨ての控えを読む。無い・壊れている・形の合わない項目は、空とみなして外す */
  private readCache(): Map<CardId, PrSnapshot> {
    const snapshots = new Map<CardId, PrSnapshot>();
    const json = parseJsonOrNull(readFileOrNull(this.cacheFile));
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return snapshots;

    for (const [id, raw] of Object.entries(json as Record<string, unknown>)) {
      if (!CardIdSchema.safeParse(id).success) continue;

      const snapshot = parsePrSnapshot(raw);
      if (snapshot !== null) snapshots.set(id as CardId, snapshot);
    }

    return snapshots;
  }

  /**
   * 使い捨ての控えを読み、変えて、書き戻す。
   *
   * `ai-board` の CLI（`status` と `decide`）の `PrFetcher` が同時に書きうるので、一時ファイルに書いてから置き換える
   * （読みかけの壊れたファイルを見せない）。後から書いた方が先の変更を消しうるが、控えなので次の問い合わせで戻る。
   */
  private updateCache(change: (cache: Map<CardId, PrSnapshot>) => unknown): void {
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

function warnStoreFailure(cardId: CardId, message: string, error: StoreError): void {
  console.warn(`[ai-board] ${cardId} の${message}: ${error.type}`);
}

function parseJsonOrNull(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
