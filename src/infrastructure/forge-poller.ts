import type { CardRepository } from '../cards/repositories/card.repository.js';
import type { Card } from '../cards/models/card.js';
import type { ForgeClient } from '../board/services/forge-client.js';
import type { MrStateProvider } from '../board/services/mr-state-provider.js';
import type { ForgeConnection, MrState } from '../board/models/mr-state.js';

// ============================================================
// レビュー要求のポーリング
// ============================================================

export const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface ForgePollerOptions {
  readonly intervalMs?: number;
  /** MR 状態が変わったときに呼ばれる（SSE 通知に使う） */
  readonly onUpdate?: () => void;
}

/**
 * カード単位で MR を問い合わせ、結果をメモリにキャッシュする。
 *
 * MR 一覧の全件取得はページングで取りこぼすため使わない。
 * 取得先がダウンしていてもボードは落とさず、接続状態だけを error にする。
 */
export class ForgePoller implements MrStateProvider {
  private readonly cache = new Map<string, MrState>();
  private connectionState: ForgeConnection;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly cardRepository: CardRepository,
    private readonly client: ForgeClient,
    private readonly options: ForgePollerOptions = {}
  ) {
    this.connectionState = { status: 'connected', kind: client.kind };
  }

  get(cardId: string): MrState | null {
    return this.cache.get(cardId) ?? null;
  }

  connection(): ForgeConnection {
    return this.connectionState;
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
      const cards = await this.cardRepository.findAll();
      const targets = cards.filter((card) => card.mr !== null || card.branch !== null);

      let changed = false;
      let firstError: string | null = null;

      for (const card of targets) {
        try {
          changed = (await this.refreshCard(card)) || changed;
        } catch (error) {
          firstError ??= error instanceof Error ? error.message : String(error);
        }
      }

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

  /** カード 1 枚分のレビュー要求を引き直す。キャッシュが変わったら true */
  private async refreshCard(card: Card): Promise<boolean> {
    const mr = await this.fetchFor(card);

    if (mr === null) {
      return this.cache.delete(card.id);
    }

    const changed = !isSameMrState(this.cache.get(card.id), mr);
    if (changed) {
      this.cache.set(card.id, mr);
    }

    // 番号と取得先は必ず対で書き戻す。
    // 片方だけ残っていると、取得先を切り替えたときに別のレビュー要求を引く。
    if (card.mr !== mr.iid || card.forge !== this.client.kind) {
      await this.cardRepository.save({ ...card, mr: mr.iid, forge: this.client.kind });
    }

    return changed;
  }

  /**
   * カードから問い合わせ方を決める。
   *
   * 識別番号は取得先ごとに独立していて、同じ番号が両方に存在し得る。
   * カードの `forge` が現在の取得先と違えば、その番号は別物なので使わない。
   * `forge` が無い古いカードは、ブランチがあればそちらを正とする。
   */
  private async fetchFor(card: Card): Promise<MrState | null> {
    if (card.forge === this.client.kind && card.mr !== null) {
      return this.client.fetchByIid(card.mr);
    }

    if (card.branch !== null) {
      return this.client.fetchByBranch(card.branch);
    }

    // 取得先の記録が無く、ブランチも無い。番号を現在の取得先のものとして扱う
    if (card.forge === null && card.mr !== null) {
      return this.client.fetchByIid(card.mr);
    }

    return null;
  }
}

/** 変化検出用の比較。ステージ判定に効くフィールドだけを見る */
function isSameMrState(a: MrState | undefined, b: MrState): boolean {
  return (
    a !== undefined &&
    a.iid === b.iid &&
    a.state === b.state &&
    a.latestNoteAt === b.latestNoteAt &&
    a.latestCommitAt === b.latestCommitAt &&
    a.noteCount === b.noteCount
  );
}
