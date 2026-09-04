import type { MergeRequestIid } from '../shared/schemas/common.js';
import type { CardRepository } from '../cards/repositories/card.repository.js';
import type { Card } from '../cards/models/card.js';
import type { GitLabClient } from '../board/services/gitlab-client.js';
import type { MrStateProvider } from '../board/services/mr-state-provider.js';
import type { GitLabConnection, MrState } from '../board/models/mr-state.js';

// ============================================================
// GitLab ポーリング
// ============================================================

export const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface GitLabPollerOptions {
  readonly intervalMs?: number;
  /** MR 状態が変わったときに呼ばれる（SSE 通知に使う） */
  readonly onUpdate?: () => void;
}

/**
 * カード単位で MR を問い合わせ、結果をメモリにキャッシュする。
 *
 * MR 一覧の全件取得はページングで取りこぼすため使わない。
 * GitLab がダウンしていてもボードは落とさず、接続状態だけを error にする。
 */
export class GitLabPoller implements MrStateProvider {
  private readonly cache = new Map<string, MrState>();
  private connectionState: GitLabConnection = { status: 'connected' };
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly cardRepository: CardRepository,
    private readonly client: GitLabClient,
    private readonly options: GitLabPollerOptions = {}
  ) {}

  get(cardId: string): MrState | null {
    return this.cache.get(cardId) ?? null;
  }

  connection(): GitLabConnection {
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
   * 全カードの MR 状態を引き直す。
   *
   * 前回の実行が終わっていなければ skip する（GitLab が遅いときに
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
        firstError === null ? { status: 'connected' } : { status: 'error', message: firstError };

      if (changed) {
        this.options.onUpdate?.();
      }
    } catch (error) {
      this.connectionState = {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.running = false;
    }
  }

  /** カード 1 枚分の MR を引き直す。キャッシュが変わったら true */
  private async refreshCard(card: Card): Promise<boolean> {
    const mr = await this.fetchFor(card.mr, card.branch);

    if (mr === null) {
      return this.cache.delete(card.id);
    }

    const changed = !isSameMrState(this.cache.get(card.id), mr);
    if (changed) {
      this.cache.set(card.id, mr);
    }

    // branch だけ書かれたカードに iid を書き戻す。
    // 次回以降のポーリングでリクエストが 1 本減る。
    if (card.mr === null) {
      await this.cardRepository.save({ ...card, mr: mr.iid });
    }

    return changed;
  }

  private async fetchFor(
    iid: MergeRequestIid | null,
    branch: string | null
  ): Promise<MrState | null> {
    if (iid !== null) {
      return this.client.fetchByIid(iid);
    }
    if (branch !== null) {
      return this.client.fetchByBranch(branch);
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
