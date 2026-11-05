import type { CardRepository } from '../cards/repositories/card.repository.js';
import type { Card } from '../cards/models/card.js';
import type { CardId } from '../shared/schemas/common.js';
import { ForgeRequestError, type ForgeClient } from '../board/services/forge-client.js';
import type { MrStateProvider } from '../board/services/mr-state-provider.js';
import type { MrSnapshotRepository } from '../board/repositories/mr-snapshot.repository.js';
import type {
  ForgeCardFailure,
  ForgeConnection,
  MrSnapshot,
  MrState,
} from '../board/models/mr-state.js';

// ============================================================
// レビュー要求の問い合わせ
// ============================================================

/**
 * ブランチから解決した PR 番号を、カードに書き戻す。
 *
 * 書く直前にカードを読み直し、番号以外は触らない。番号が既に入っていれば何も書かない。
 * 書けなかったときは例外を投げずに警告にとどめる（番号は次の問い合わせでブランチから解決し直される）。
 */
export type MrNumberWriter = (cardId: CardId, iid: MrState['iid']) => Promise<void>;

export interface ForgePollerOptions {
  /** PR の状態が変わったときに呼ばれる */
  readonly onUpdate?: () => void;
  /**
   * PR 番号の書き戻し。データ用ブランチでは `DataStore.transact` を通すものを渡す
   * （ファイルを書くだけでは、次の取り直しで捨てられる）。
   * 既定はカードのリポジトリへ直接書く。
   */
  readonly writeMr?: MrNumberWriter;
}

/**
 * カード単位で PR を問い合わせ、結果をメモリにキャッシュする。
 *
 * PR 一覧の全件取得はページングで取りこぼすため使わない。
 * 取得先がダウンしていてもボードは落とさず、接続状態だけを error にする。
 * 1 枚の PR だけに効く失敗（`ForgeRequestError` の `scope` が `card`）では接続を止めず、
 * そのカードの失敗（`failure`）として持つ。前に引けた控えは消さずに `get` で返す。
 *
 * キャッシュは控え（`MrSnapshotRepository`）にも書き、最初の `refresh` で読み戻す。
 * `ai-board status` は呼ばれるたびに新しいプロセスで 1 度だけ `refresh` するので、
 * 控えが無いと毎回すべての PR を詳細まで引き直すことになる。
 */
export class ForgePoller implements MrStateProvider {
  private readonly cache = new Map<CardId, MrSnapshot>();
  private readonly failures = new Map<CardId, ForgeCardFailure>();
  private connectionState: ForgeConnection;
  private running = false;
  private refreshed = false;
  private loaded = false;

  constructor(
    private readonly cardRepository: CardRepository,
    private readonly client: ForgeClient,
    private readonly snapshotRepository: MrSnapshotRepository,
    private readonly options: ForgePollerOptions = {}
  ) {
    this.connectionState = { status: 'connected', kind: client.kind };
  }

  get(cardId: string): MrState | null {
    return this.cache.get(cardId as CardId)?.mr ?? null;
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

  /**
   * 全カードのレビュー要求の状態を引き直す。
   *
   * 前回の実行が終わっていなければ skip する（取得先が遅いときに
   * リクエストが積み上がるのを防ぐ）。
   */
  async refresh(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      await this.load();

      const cards = await this.cardRepository.findAll();
      const targets = cards.filter((card) => card.mr !== null || card.branch !== null);

      let changed = await this.forgetUntracked(targets);
      let firstError: string | null = null;
      const now = new Date().toISOString();

      for (const card of targets) {
        const outcome = await this.refreshTracked(card, now);
        changed = outcome.changed || changed;
        firstError ??= outcome.globalError;
      }

      this.refreshed = true;
      this.connectionState =
        firstError === null
          ? { status: 'connected', kind: this.client.kind }
          : { status: 'error', kind: this.client.kind, message: firstError };

      if (changed) {
        this.options.onUpdate?.();
      }
    } catch (error) {
      this.connectionState = {
        status: 'error',
        kind: this.client.kind,
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.running = false;
    }
  }

  /**
   * カード 1 枚を引き直し、失敗を振り分ける。
   * そのカードだけの失敗は `failures` に持ち、全体に効く失敗は `globalError` に返す（接続を error にする）
   */
  private async refreshTracked(
    card: Card,
    now: string
  ): Promise<{ readonly changed: boolean; readonly globalError: string | null }> {
    try {
      const changed = await this.refreshCard(card);
      return { changed: this.failures.delete(card.id) || changed, globalError: null };
    } catch (error) {
      const message = `${describeTarget(card)}${describeError(error)}`;

      if (error instanceof ForgeRequestError && error.scope === 'card') {
        return { changed: this.recordFailure(card.id, message, now), globalError: null };
      }
      return { changed: false, globalError: `${card.id}: ${message}` };
    }
  }

  /**
   * カードの失敗を持つ。失敗が続くあいだは最初の時刻を保つ。中身が変わったら true
   */
  private recordFailure(cardId: CardId, message: string, now: string): boolean {
    const previous = this.failures.get(cardId);
    if (previous?.message === message) return false;

    this.failures.set(cardId, { message, since: previous?.since ?? now });
    return true;
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
  private async forgetUntracked(targets: readonly Card[]): Promise<boolean> {
    const tracked = new Set<CardId>(targets.map((card) => card.id));
    let changed = false;

    for (const cardId of [...this.cache.keys()]) {
      if (tracked.has(cardId)) continue;

      this.cache.delete(cardId);
      await this.snapshotRepository.delete(cardId);
      changed = true;
    }

    for (const cardId of [...this.failures.keys()]) {
      if (!tracked.has(cardId)) changed = this.failures.delete(cardId) || changed;
    }

    return changed;
  }

  /** カード 1 枚分のレビュー要求を引き直す。キャッシュが変わったら true */
  private async refreshCard(card: Card): Promise<boolean> {
    const previous = this.cache.get(card.id) ?? null;

    if (isSettled(card, previous)) return false;

    const snapshot = await this.fetchFor(card, previous);

    if (snapshot === null) {
      if (!this.cache.delete(card.id)) return false;

      await this.snapshotRepository.delete(card.id);
      return true;
    }

    // 指紋が同じなら client は previous をそのまま返す。そのときは書かない
    if (snapshot !== previous) {
      this.cache.set(card.id, snapshot);
      await this.snapshotRepository.save(card.id, snapshot);
    }

    if (card.mr !== snapshot.mr.iid) {
      await (this.options.writeMr ?? this.saveMr)(card.id, snapshot.mr.iid);
    }

    return !isSameMrState(previous?.mr, snapshot.mr);
  }

  /**
   * PR 番号だけを、カードのリポジトリへ直接書き戻す（`writeMr` を渡さなかったとき）。
   *
   * `refresh()` の最初に読んだカードは、問い合わせを待つ数秒のうちに古くなっている
   * （人が承認・着手・並べ替えをしているかもしれない）。書く直前に読み直し、番号以外は触らない。
   */
  private readonly saveMr: MrNumberWriter = async (cardId, iid) => {
    const latest = await this.cardRepository.findById(cardId);

    if (latest !== null && latest.mr !== iid) {
      await this.cardRepository.save({ ...latest, mr: iid });
    }
  };

  /** 番号が分かっていれば番号で、無ければブランチから解決する */
  private async fetchFor(card: Card, previous: MrSnapshot | null): Promise<MrSnapshot | null> {
    if (card.mr !== null) {
      return this.client.fetchByIid(card.mr, previous);
    }

    if (card.branch !== null) {
      return this.client.fetchByBranch(card.branch);
    }

    return null;
  }
}

/** 何を引こうとしたか。番号が分かっていれば番号、無ければブランチ */
function describeTarget(card: Card): string {
  if (card.mr !== null) return `PR #${card.mr} の取得`;
  return `ブランチ ${card.branch ?? ''} の PR の解決`;
}

/** `ForgeRequestError` は問い合わせ先を括弧に入れて添える（例: `（pulls/68）が HTTP 422 で失敗した`） */
function describeError(error: unknown): string {
  if (error instanceof ForgeRequestError) return `（${error.endpoint}）${error.failure}`;
  return `に失敗した（${error instanceof Error ? error.message : String(error)}）`;
}

/**
 * もう引き直さなくてよいか。マージ済みの PR は二度と変わらない。
 *
 * カードの番号が控えの番号と違えば（ブランチを付け替えて番号が外れた・変わった）引き直す。
 * マージされずに閉じた PR は reopen されうるので、引き続き引く。
 */
function isSettled(card: Card, previous: MrSnapshot | null): boolean {
  return previous !== null && previous.mr.state === 'merged' && card.mr === previous.mr.iid;
}

/** 変化検出用の比較。ステージ判定・止まりの判定・区間の導出に効くフィールドだけを見る */
function isSameMrState(a: MrState | undefined, b: MrState): boolean {
  return (
    a !== undefined &&
    a.iid === b.iid &&
    a.state === b.state &&
    a.draft === b.draft &&
    a.latestNoteAt === b.latestNoteAt &&
    a.latestCommitAt === b.latestCommitAt &&
    a.noteCount === b.noteCount &&
    a.latestAiNoteAt === b.latestAiNoteAt &&
    a.readyAt === b.readyAt &&
    a.convertedToDraftAt === b.convertedToDraftAt
  );
}
