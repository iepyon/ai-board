import type { CardRepository } from '../cards/repositories/card.repository.js';
import type { Card } from '../cards/models/card.js';
import type { CardId } from '../shared/schemas/common.js';
import type { ForgeClient } from '../board/services/forge-client.js';
import type { MrStateProvider } from '../board/services/mr-state-provider.js';
import type { MrSnapshotRepository } from '../board/repositories/mr-snapshot.repository.js';
import type { ForgeConnection, MrSnapshot, MrState } from '../board/models/mr-state.js';

// ============================================================
// レビュー要求のポーリング
// ============================================================

export const DEFAULT_POLL_INTERVAL_MS = 60_000;

export interface ForgePollerOptions {
  readonly intervalMs?: number;
  /** PR の状態が変わったときに呼ばれる（SSE 通知に使う） */
  readonly onUpdate?: () => void;
}

/**
 * カード単位で PR を問い合わせ、結果をメモリにキャッシュする。
 *
 * PR 一覧の全件取得はページングで取りこぼすため使わない。
 * 取得先がダウンしていてもボードは落とさず、接続状態だけを error にする。
 *
 * キャッシュは DB の控え（`MrSnapshotRepository`）にも書き、最初の `refresh` で読み戻す。
 * `ai-board status` は呼ばれるたびに新しいプロセスで 1 度だけ `refresh` するので、
 * 控えが無いと毎回すべての PR を詳細まで引き直すことになる。
 */
export class ForgePoller implements MrStateProvider {
  private readonly cache = new Map<CardId, MrSnapshot>();
  private connectionState: ForgeConnection;
  private timer: NodeJS.Timeout | null = null;
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

  connection(): ForgeConnection {
    return this.connectionState;
  }

  /** 初回の `refresh` が全カードを回り終えたか。起動直後のキャッシュは空で、PR が無いのと見分けが付かない */
  synced(): boolean {
    return this.refreshed;
  }

  start(): void {
    if (this.timer !== null) return;

    const interval = this.options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), interval);
    // ポーリングだけでプロセスを生かし続けない
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
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

      for (const card of targets) {
        try {
          changed = (await this.refreshCard(card)) || changed;
        } catch (error) {
          firstError ??= error instanceof Error ? error.message : String(error);
        }
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

  /** DB の控えをキャッシュへ読み戻す。プロセスごとに 1 度だけ */
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
      await this.saveMr(card.id, snapshot.mr.iid);
    }

    return !isSameMrState(previous?.mr, snapshot.mr);
  }

  /**
   * PR 番号だけを書き戻す。
   *
   * `refresh()` の最初に読んだカードは、問い合わせを待つ数秒のうちに古くなっている
   * （人が承認・着手・並べ替えをしているかもしれない）。書く直前に読み直し、番号以外は触らない。
   */
  private async saveMr(cardId: Card['id'], iid: MrState['iid']): Promise<void> {
    const latest = await this.cardRepository.findById(cardId);

    if (latest !== null && latest.mr !== iid) {
      await this.cardRepository.save({ ...latest, mr: iid });
    }
  }

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
    a.readyAt === b.readyAt &&
    a.convertedToDraftAt === b.convertedToDraftAt
  );
}
