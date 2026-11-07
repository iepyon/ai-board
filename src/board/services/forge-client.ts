import type { PullRequestNumber } from '../../shared/schemas/common.js';
import type { ForgeKind, PrSnapshot } from '../models/pr-state.js';
import { describeCliError, type CliError } from '../../infrastructure/cli-runner.js';

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
  /**
   * 識別番号が既知のレビュー要求を取得する。
   * `previous` から変わっていなければ、詳細を引き直さずに `previous` を返す
   */
  fetchByNumber(
    number: PullRequestNumber,
    previous?: PrSnapshot | null
  ): Promise<PrSnapshot | null>;
  /** source branch からレビュー要求を解決する。複数ある場合は最新の 1 件 */
  fetchByBranch(branch: string): Promise<PrSnapshot | null>;
  /** 取得先へ問い合わせられる状態かを確かめる。理由文を返す（null なら利用可能） */
  checkAuth(): Promise<string | null>;
}

// ============================================================
// 取得の失敗
// ============================================================

/**
 * 失敗がどこまで効くか。
 *
 * - `global`: どのカードの問い合わせでも同じに起きる失敗（CLI が無い、ネットワークの断・タイムアウト、認証、上限、GitHub の障害）。
 *   接続の状態をまるごと `error` にする
 * - `card`: その PR の中身に依る失敗（422 など）。そのカードだけを止め、ほかのカードは今までどおり導出する
 */
export type ForgeFailureScope = 'global' | 'card';

/** 全体に効く HTTP のステータス。認証（401）・権限や上限（403）・上限（429） */
const GLOBAL_HTTP_STATUSES: ReadonlySet<number> = new Set([401, 403, 429]);

/**
 * CLI の失敗を、全体に効くものとカードだけのものに見分ける。
 *
 * 全カードが失敗したら全体、という数え方にしないのは、カードが 1 枚しか無いときに見分けられないため。
 * 5xx を全体にするのは、GitHub の障害で全カードが一度に止まりになり、判断待ちが埋まるのを避けるため。
 * HTTP のステータスが取れない失敗（ネットワークの断・タイムアウトなど）も全体にする。
 */
export function failureScope(error: CliError): ForgeFailureScope {
  switch (error.type) {
    case 'NotInstalled':
      return 'global';
    case 'InvalidJson':
      return 'card';
    case 'Failed': {
      const status = error.httpStatus;
      if (status === null || status >= 500 || GLOBAL_HTTP_STATUSES.has(status)) return 'global';
      return 'card';
    }
  }
}

/**
 * 取得先への問い合わせの失敗。どの問い合わせが、どの HTTP のステータスで失敗したかを持つ。
 *
 * `gh` の stderr の本文は載せない（資格情報が混じりうる。`cli-runner.ts` の `describe`）。
 * 問い合わせ先はクエリを落とした道だけにする（ブランチ名などはクエリに入る）。
 */
export class ForgeRequestError extends Error {
  readonly endpoint: string;
  readonly httpStatus: number | null;
  /** 問い合わせ先に続ける述語（`が HTTP 422 で失敗した` など）。呼び出し側が問い合わせ先と組み合わせて文を作る */
  readonly failure: string;
  readonly scope: ForgeFailureScope;

  constructor(endpoint: string, error: CliError) {
    const pathOnly = stripQuery(endpoint);
    const httpStatus = error.type === 'Failed' ? error.httpStatus : null;
    const failure =
      httpStatus === null
        ? `が失敗した（${describeCliError(error)}）`
        : `が HTTP ${httpStatus} で失敗した`;
    super(`${pathOnly} ${failure}`);
    this.name = 'ForgeRequestError';
    this.endpoint = pathOnly;
    this.httpStatus = httpStatus;
    this.failure = failure;
    this.scope = failureScope(error);
  }
}

function stripQuery(endpoint: string): string {
  const index = endpoint.indexOf('?');
  return index === -1 ? endpoint : endpoint.slice(0, index);
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

export function toPullRequestNumber(raw: number): PullRequestNumber {
  return raw as PullRequestNumber;
}
