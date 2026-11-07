import type { CardRepository } from '../cards/repositories/card.repository.js';
import type { Card } from '../cards/models/card.js';
import type { CardId } from '../shared/schemas/common.js';
import { ForgeRequestError, type ForgeClient } from '../board/services/forge-client.js';
import { canReuseSnapshot, type PrStateProvider } from '../board/services/pr-state-provider.js';
import type { PrSnapshotRepository } from '../board/repositories/pr-snapshot.repository.js';
import type {
  ForgeCardFailure,
  ForgeConnection,
  PrSnapshot,
  PrState,
} from '../board/models/pr-state.js';

// ============================================================
// レビュー要求の問い合わせ
// ============================================================

/**
 * ブランチから解決した PR 番号を、カードに書き戻す。
 *
 * 書く直前にカードを読み直し、番号以外は触らない。番号が既に入っていれば何も書かない。
 * 書けなかったときは例外を投げずに警告にとどめる（番号は次の問い合わせでブランチから解決し直される）。
 */
export type PrNumberWriter = (cardId: CardId, number: PrState['number']) => Promise<void>;

export interface PrFetcherOptions {
  /**
   * PR 番号の書き戻し。データ用ブランチでは `DataStore.transact` を通すものを渡す
   * （ファイルを書くだけでは、次の取り直しで捨てられる）。
   * 既定はカードのリポジトリへ直接書く。
   */
  readonly writePr?: PrNumberWriter;
}

/**
 * カード単位で PR を問い合わせ、結果をメモリにキャッシュする。
 *
 * PR 一覧の全件取得はページングで取りこぼすため使わない。
 * 取得先がダウンしていてもボードは落とさず、接続状態だけを error にする。
 * 1 枚の PR だけに効く失敗（`ForgeRequestError` の `scope` が `card`）では接続を止めず、
 * そのカードの失敗（`failure`）として持つ。前に引けた控えは消さずに `get` で返す。
 *
 * キャッシュは控え（`PrSnapshotRepository`）にも書き、最初の `refresh` で読み戻す。
 * `ai-board status` は呼ばれるたびに新しいプロセスで 1 度だけ `refresh` するので、
 * 控えが無いと毎回すべての PR を詳細まで引き直すことになる。
 */
export class PrFetcher implements PrStateProvider {
  private readonly cache = new Map<CardId, PrSnapshot>();
  private readonly failures = new Map<CardId, ForgeCardFailure>();
  private connectionState: ForgeConnection;
  private refreshed = false;
  private loaded = false;

  constructor(
    private readonly cardRepository: CardRepository,
    private readonly client: ForgeClient,
    private readonly snapshotRepository: PrSnapshotRepository,
    private readonly options: PrFetcherOptions = {}
  ) {
    this.connectionState = { status: 'connected', kind: client.kind };
  }

  get(cardId: string): PrState | null {
    return this.cache.get(cardId as CardId)?.pr ?? null;
  }

  failure(cardId: string): ForgeCardFailure | null {
    return this.failures.get(cardId as CardId) ?? null;
  }

  connection(): ForgeConnection {
    return this.connectionState;
  }

  /** 初回の `refresh` が全カードを回り終えたか。起動直後のキャッシュは空で、PR が無いのと見分けが付かない */
  synced(): boolean {
    return this.refreshed;
  }

  /** 全カードのレビュー要求の状態を引き直す。1 回の実行で 1 度だけ呼ぶ */
  async refresh(): Promise<void> {
    try {
      await this.load();

      const cards = await this.cardRepository.findAll();
      const targets = cards.filter((card) => card.pr !== null || card.branch !== null);

      await this.forgetUntracked(targets);
      let firstError: string | null = null;
      const now = new Date().toISOString();

      for (const card of targets) {
        firstError ??= await this.refreshTracked(card, now);
      }

      this.refreshed = true;
      this.connectionState =
        firstError === null
          ? { status: 'connected', kind: this.client.kind }
          : { status: 'error', kind: this.client.kind, message: firstError };
    } catch (error) {
      this.connectionState = {
        status: 'error',
        kind: this.client.kind,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * カード 1 枚を引き直し、失敗を振り分ける。
   * そのカードだけの失敗は `failures` に持ち、全体に効く失敗は返す（接続を error にする）。失敗が無ければ null
   */
  private async refreshTracked(card: Card, now: string): Promise<string | null> {
    try {
      await this.refreshCard(card);
      this.failures.delete(card.id);
      return null;
    } catch (error) {
      const message = `${describeTarget(card)}${describeError(error)}`;

      if (error instanceof ForgeRequestError && error.scope === 'card') {
        this.recordFailure(card.id, message, now);
        return null;
      }
      return `${card.id}: ${message}`;
    }
  }

  /** カードの失敗を持つ。同じ失敗が続くあいだは最初の時刻を保つ */
  private recordFailure(cardId: CardId, message: string, now: string): void {
    const previous = this.failures.get(cardId);
    if (previous?.message === message) return;

    this.failures.set(cardId, { message, since: previous?.since ?? now });
  }

  /** 控えをキャッシュへ読み戻す。プロセスごとに 1 度だけ */
  private async load(): Promise<void> {
    if (this.loaded) return;

    for (const [cardId, snapshot] of await this.snapshotRepository.findAll()) {
      this.cache.set(cardId, snapshot);
    }
    this.loaded = true;
  }

  /**
   * 問い合わせの対象から外れたカード（PR 番号もブランチも外された、カードが無くなった）の控えを消す。
   * 残すと、ブランチを外したカードに前の PR が出続ける
   */
  private async forgetUntracked(targets: readonly Card[]): Promise<void> {
    const tracked = new Set<CardId>(targets.map((card) => card.id));

    for (const cardId of [...this.cache.keys()]) {
      if (tracked.has(cardId)) continue;

      this.cache.delete(cardId);
      await this.snapshotRepository.delete(cardId);
    }

    for (const cardId of [...this.failures.keys()]) {
      if (!tracked.has(cardId)) this.failures.delete(cardId);
    }
  }

  /**
   * カード 1 枚分のレビュー要求を引き直す。
   *
   * マージ済みの PR と中止のカードの PR は、控えがあれば引き直さずにそのまま使う（`canReuseSnapshot`）。
   * 中止のカードも問い合わせの対象（`refresh` の `targets`）には残すので、`forgetUntracked` は控えを消さない
   */
  private async refreshCard(card: Card): Promise<void> {
    const previous = this.cache.get(card.id) ?? null;

    if (canReuseSnapshot(card, previous)) return;

    const snapshot = await this.fetchFor(card, previous);

    if (snapshot === null) {
      if (this.cache.delete(card.id)) await this.snapshotRepository.delete(card.id);
      return;
    }

    // 指紋が同じなら client は previous をそのまま返す。そのときは書かない
    if (snapshot !== previous) {
      this.cache.set(card.id, snapshot);
      await this.snapshotRepository.save(card.id, snapshot);
    }

    if (card.pr !== snapshot.pr.number) {
      await (this.options.writePr ?? this.savePr)(card.id, snapshot.pr.number);
    }
  }

  /**
   * PR 番号だけを、カードのリポジトリへ直接書き戻す（`writePr` を渡さなかったとき）。
   *
   * `refresh()` の最初に読んだカードは、問い合わせを待つ数秒のうちに古くなっている
   * （人が承認・着手・並べ替えをしているかもしれない）。書く直前に読み直し、番号以外は触らない。
   */
  private readonly savePr: PrNumberWriter = async (cardId, number) => {
    const latest = await this.cardRepository.findById(cardId);

    if (latest !== null && latest.pr !== number) {
      await this.cardRepository.save({ ...latest, pr: number });
    }
  };

  /** 番号が分かっていれば番号で、無ければブランチから解決する */
  private async fetchFor(card: Card, previous: PrSnapshot | null): Promise<PrSnapshot | null> {
    if (card.pr !== null) {
      return this.client.fetchByNumber(card.pr, previous);
    }

    if (card.branch !== null) {
      return this.client.fetchByBranch(card.branch);
    }

    return null;
  }
}

/** 何を引こうとしたか。番号が分かっていれば番号、無ければブランチ */
function describeTarget(card: Card): string {
  if (card.pr !== null) return `PR #${card.pr} の取得`;
  return `ブランチ ${card.branch ?? ''} の PR の解決`;
}

/** `ForgeRequestError` は問い合わせ先を括弧に入れて添える（例: `（pulls/68）が HTTP 422 で失敗した`） */
function describeError(error: unknown): string {
  if (error instanceof ForgeRequestError) return `（${error.endpoint}）${error.failure}`;
  return `に失敗した（${error instanceof Error ? error.message : String(error)}）`;
}
