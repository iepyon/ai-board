import type { IdeaDividerRepository } from './idea-divider.repository.js';
import {
  readOrderLeniently,
  readOrderStrictly,
  settle,
  writeOrder,
} from './file-card.repository.js';

// ============================================================
// データのワークツリーのファイルによる区切り線リポジトリ実装
// ============================================================

/**
 * `order.yaml` の `divider` を読み書きする。`ranks` には触らない。
 *
 * `onWrite` の役割は `FileCardRepository` と同じ（自分の書き込みを SSE へ知らせる）。
 */
export class FileIdeaDividerRepository implements IdeaDividerRepository {
  constructor(
    private readonly dataDir: string,
    private readonly onWrite: () => void = () => undefined
  ) {}

  get(): Promise<number | null> {
    return settle(() => readOrderLeniently(this.dataDir).divider);
  }

  /** `order.yaml` が壊れていれば、書き戻すと全カードの rank を失うので、書かずに例外を投げる */
  set(rank: number): Promise<void> {
    return settle(() => {
      const order = readOrderStrictly(this.dataDir);
      writeOrder(this.dataDir, { ...order, divider: rank });
      this.onWrite();
    });
  }
}
