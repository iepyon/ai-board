import { isErr } from '../../shared/result.js';
import { CardIdSchema, type CardId } from '../../shared/schemas/common.js';
import type { DocumentStore } from '../../infrastructure/document-store.js';
import type { Card } from '../models/card.js';
import type { ReviewEntry } from '../models/review.js';
import type { CardRepository } from './card.repository.js';
import type { IdeaDividerRepository } from './idea-divider.repository.js';
import { compareCards } from '../services/card-order.js';
import {
  CARD_COLLECTION,
  EMPTY_ORDER,
  LOG_COLLECTION,
  ORDER_COLLECTION,
  ORDER_ID,
  assembleCard,
  cardIdOfLogDocument,
  cardMarkdownFromDocument,
  logDocumentData,
  logDocumentId,
  logFileFromDocument,
  orderDocumentData,
  parseOrderData,
  planCardWrite,
  planReviewAppend,
  withRank,
  type CardWriteError,
  type LogFile,
  type OrderFile,
  type OrderFileError,
  type StoredCard,
} from './card-files.js';

// ============================================================
// 置き場所の文書によるカード・区切り線のリポジトリ実装
// ============================================================

/**
 * 書き込みを拒んだ理由。インターフェースの `boolean` は「カードが無い」を表すので、拒否は例外で知らせる。
 *
 * - 保存しようとする本文が既存の判断のエントリを変えている・足している（`save` は判断を作らない）
 * - 着手の時刻が判断の最新にならない、時刻が判断の名前にできない
 * - 今のカードの文書や並び順の文書が読めない（読み流して書き戻すと、中身を失う）
 */
export class CardWriteRefusedError extends Error {
  constructor(readonly reason: CardWriteError | OrderFileError) {
    super(`カードの書き込みを拒みました: ${reason.type}`);
    this.name = 'CardWriteRefusedError';
  }
}

export interface DocCardRepositoryOptions {
  /** 着手を戻した時刻に使う。テストで差し替える */
  readonly now?: () => Date;
}

/**
 * 置き場所の `cards/<id>`・`log/<id>.<判断>`・`order/order` を読み書きする。
 *
 * 文書はいったん `card.md` と `log/` のファイルの形に写し、組み立てと書く前の検査は `card-files.ts` の純関数が行う。
 * 書き込みは `DocumentStore.transact` の中で呼ばれる前提である（外で書くと口が例外を投げる）。
 */
export class DocCardRepository implements CardRepository {
  private readonly now: () => Date;

  constructor(
    private readonly store: DocumentStore,
    options: DocCardRepositoryOptions = {}
  ) {
    this.now = options.now ?? (() => new Date());
  }

  findAll(): Promise<Card[]> {
    return settle(() => {
      const order = readOrderLeniently(this.store);
      const logs = this.logsByCard();
      const cards: Card[] = [];

      for (const doc of this.store.list(CARD_COLLECTION)) {
        if (!isCardId(doc.id)) {
          console.warn(
            `[ai-board] カードを読み飛ばしました: ${CARD_COLLECTION}/${doc.id} — ID として不正です`
          );
          continue;
        }
        const card = assembleCard(
          doc.id,
          { cardMd: cardMarkdownFromDocument(doc.data), log: logs.get(doc.id) ?? [] },
          order.ranks[doc.id] ?? null
        );
        if (card !== null) cards.push(card);
      }

      return cards.sort(compareCards);
    });
  }

  findById(id: CardId): Promise<Card | null> {
    return settle(() => {
      if (!isCardId(id)) return null;

      const stored = this.readStored(id, readOrderLeniently(this.store));
      return stored === null ? null : assembleCard(id, stored.files, stored.rank);
    });
  }

  create(card: Card): Promise<boolean> {
    return settle(() => {
      // 読めないカードの文書でもあれば既存とみなし、上書きしない
      if (!isCardId(card.id) || this.store.get(CARD_COLLECTION, card.id) !== null) return false;

      this.write(null, card);
      return true;
    });
  }

  save(card: Card): Promise<boolean> {
    return settle(() => {
      if (!isCardId(card.id)) return false;

      const stored = this.readStored(card.id, readOrderLeniently(this.store));
      if (stored === null) return false;

      this.write(stored, card);
      return true;
    });
  }

  appendReview(id: CardId, entry: ReviewEntry): Promise<boolean> {
    return settle(() => {
      if (!isCardId(id)) return false;

      const stored = this.readStored(id, readOrderLeniently(this.store));
      if (stored === null) return false;

      const planned = planReviewAppend(id, stored, entry);
      if (isErr(planned)) throw new CardWriteRefusedError(planned.error);

      this.addLog(id, planned.value);
      return true;
    });
  }

  /** `planCardWrite` が求めた書き込みをする。拒まれたら何も書かずに例外を投げる */
  private write(stored: StoredCard | null, card: Card): void {
    const planned = planCardWrite(stored, card, this.now().toISOString());
    if (isErr(planned)) throw new CardWriteRefusedError(planned.error);

    const { cardDocument, logFiles, rankChanged } = planned.value;
    // 並び順の文書が壊れていれば、カードの文書を書く前に拒む
    const order = rankChanged ? readOrderStrictly(this.store) : null;

    if (cardDocument !== null) this.store.set(CARD_COLLECTION, card.id, { ...cardDocument });
    for (const file of logFiles) this.addLog(card.id, file);
    if (order !== null) writeOrder(this.store, withRank(order, card.id, card.rank));
  }

  /** 判断は追記だけ。同じ ID の文書が既にあれば書き換えずに失敗する */
  private addLog(id: string, file: LogFile): void {
    const docId = logDocumentId(id, file.name);
    if (this.store.get(LOG_COLLECTION, docId) !== null) {
      throw new Error(`判断の文書が既にあります: ${LOG_COLLECTION}/${docId}`);
    }
    this.store.set(LOG_COLLECTION, docId, logDocumentData(id, file));
  }

  /** 1 枚のカードの文書と判断を読む。カードの文書が無ければ null */
  private readStored(id: string, order: OrderFile): StoredCard | null {
    const doc = this.store.get(CARD_COLLECTION, id);
    if (doc === null) return null;

    return {
      files: { cardMd: cardMarkdownFromDocument(doc), log: this.logsOf(id) },
      rank: order.ranks[id] ?? null,
    };
  }

  private logsOf(id: string): LogFile[] {
    return this.logsByCard().get(id) ?? [];
  }

  /** 判断の文書をカードごとに分ける */
  private logsByCard(): Map<string, LogFile[]> {
    const byCard = new Map<string, LogFile[]>();
    for (const doc of this.store.list(LOG_COLLECTION)) {
      const cardId = cardIdOfLogDocument(doc.id);
      const files = byCard.get(cardId) ?? [];
      files.push(logFileFromDocument(cardId, doc.id, doc.data));
      byCard.set(cardId, files);
    }
    return byCard;
  }
}

/** 並び順の文書の `divider` を読み書きする。`ranks` には触らない */
export class DocIdeaDividerRepository implements IdeaDividerRepository {
  constructor(private readonly store: DocumentStore) {}

  get(): Promise<number | null> {
    return settle(() => readOrderLeniently(this.store).divider);
  }

  /** 並び順の文書が壊れていれば、書き戻すと全カードの rank を失うので、書かずに例外を投げる */
  set(rank: number): Promise<void> {
    return settle(() => {
      const order = readOrderStrictly(this.store);
      writeOrder(this.store, { ...order, divider: rank });
    });
  }
}

// ============================================================
// 並び順の文書の読み書き
// ============================================================

/**
 * 読み出し用。並び順の文書が壊れていれば警告して空とみなす（1 つの文書でボード全体を止めない）。
 * 書き戻すと全カードの rank を失うので、書き込みには使わない。
 */
export function readOrderLeniently(store: Pick<DocumentStore, 'get'>): OrderFile {
  const parsed = parseOrderData(store.get(ORDER_COLLECTION, ORDER_ID));
  if (!isErr(parsed)) return parsed.value;

  console.warn(
    `[ai-board] ${ORDER_COLLECTION}/${ORDER_ID} を読めないため、並び順を空とみなします: ${parsed.error.reason}`
  );
  return EMPTY_ORDER;
}

/** 書き込み用。並び順の文書が壊れていれば、書き戻さずに例外を投げる */
export function readOrderStrictly(store: Pick<DocumentStore, 'get'>): OrderFile {
  const parsed = parseOrderData(store.get(ORDER_COLLECTION, ORDER_ID));
  if (isErr(parsed)) throw new CardWriteRefusedError(parsed.error);

  return parsed.value;
}

export function writeOrder(store: Pick<DocumentStore, 'set'>, order: OrderFile): void {
  store.set(ORDER_COLLECTION, ORDER_ID, orderDocumentData(order));
}

// ============================================================
// ヘルパー
// ============================================================

/** 同期の処理を Promise にする。投げた例外は reject として返す */
export function settle<T>(fn: () => T): Promise<T> {
  return new Promise((resolve) => resolve(fn()));
}

function isCardId(id: string): boolean {
  return CardIdSchema.safeParse(id).success;
}
