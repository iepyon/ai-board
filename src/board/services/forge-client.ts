import type { MergeRequestIid } from '../../shared/schemas/common.js';
import type { ForgeKind, MrState } from '../models/mr-state.js';

// ============================================================
// レビュー要求の取得先
// ============================================================

/**
 * GitHub の Pull Request を取得する。
 *
 * カード単位で問い合わせる。一覧の全件取得はページングで取りこぼすため使わない。
 * 認証は持たない。実装は利用者の環境にログイン済みの CLI へ委ねる。
 */
export interface ForgeClient {
  /** どの取得先の実装か */
  readonly kind: ForgeKind;
  /** 識別番号が既知のレビュー要求を取得する */
  fetchByIid(iid: MergeRequestIid): Promise<MrState | null>;
  /** source branch からレビュー要求を解決する。複数ある場合は最新の 1 件 */
  fetchByBranch(branch: string): Promise<MrState | null>;
  /** 取得先へ問い合わせられる状態かを確かめる。理由文を返す（null なら利用可能） */
  checkAuth(): Promise<string | null>;
}

// ============================================================
// 実装が共有するヘルパー
// ============================================================

/** 想定外のレスポンス形（プロキシの HTML など）でクラッシュさせない */
export function asArray<T>(value: T[] | null): T[] {
  return Array.isArray(value) ? value : [];
}

/** ISO 8601 文字列の配列から最も新しいものを返す */
export function latestOf(timestamps: readonly string[]): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;

  for (const timestamp of timestamps) {
    const ms = Date.parse(timestamp);
    if (Number.isNaN(ms)) continue;
    if (ms > latestMs) {
      latestMs = ms;
      latest = timestamp;
    }
  }

  return latest;
}

export function toMergeRequestIid(raw: number): MergeRequestIid {
  return raw as MergeRequestIid;
}
