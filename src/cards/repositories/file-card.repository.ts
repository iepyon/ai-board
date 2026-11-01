import * as fs from 'node:fs';
import * as path from 'node:path';
import { isErr } from '../../shared/result.js';
import { CardIdSchema, type CardId } from '../../shared/schemas/common.js';
import type { Card } from '../models/card.js';
import type { ReviewEntry } from '../models/review.js';
import type { CardRepository } from './card.repository.js';
import { compareCards } from '../services/card-order.js';
import {
  CARDS_DIR,
  CARD_FILE,
  LOG_DIR,
  EMPTY_ORDER,
  ORDER_FILE,
  assembleCard,
  parseOrder,
  planCardWrite,
  planReviewAppend,
  serializeOrder,
  withRank,
  type CardWriteError,
  type LogFile,
  type OrderFile,
  type OrderFileError,
  type StoredCard,
} from './card-files.js';

// ============================================================
// データのワークツリーのファイルによるカードリポジトリ実装
// ============================================================

/**
 * 書き込みを拒んだ理由。インターフェースの `boolean` は「カードが無い」を表すので、拒否は例外で知らせる。
 *
 * - 保存しようとする本文が既存の判断のエントリを変えている（判断のファイルは追記だけ）
 * - 着手の時刻が `log/` の最新にならない、時刻がファイル名にできない
 * - 今の `card.md` や `order.yaml` が読めない（読み流して書き戻すと、中身を失う）
 */
export class CardWriteRefusedError extends Error {
  constructor(readonly reason: CardWriteError | OrderFileError) {
    super(`カードの書き込みを拒みました: ${reason.type}`);
    this.name = 'CardWriteRefusedError';
  }
}

export interface FileCardRepositoryOptions {
  /** 書き込みが成立した後に呼ばれる（SSE で画面へ知らせるため） */
  readonly onWrite?: () => void;
  /** 着手を戻した時刻に使う。テストで差し替える */
  readonly now?: () => Date;
}

/**
 * データのワークツリーの `cards/<id>/` と `order.yaml` を読み書きする。
 *
 * ファイルの形は `card-files.ts` の純関数が決め、ここはファイルの読み書きだけを行う。
 * コミットと push は持たない。書き込みは `DataStore.transact` の中で呼ばれる前提である。
 */
export class FileCardRepository implements CardRepository {
  private readonly onWrite: () => void;
  private readonly now: () => Date;

  constructor(
    private readonly dataDir: string,
    options: FileCardRepositoryOptions = {}
  ) {
    this.onWrite = options.onWrite ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
  }

  findAll(): Promise<Card[]> {
    return settle(() => {
      const order = readOrderLeniently(this.dataDir);
      const cards: Card[] = [];

      for (const id of this.listCardIds()) {
        const stored = this.readStored(id, order);
        if (stored === null) continue;

        const card = assembleCard(id, stored.files, stored.rank);
        if (card !== null) cards.push(card);
      }

      return cards.sort(compareCards);
    });
  }

  findById(id: CardId): Promise<Card | null> {
    return settle(() => {
      if (!isCardId(id)) return null;

      const stored = this.readStored(id, readOrderLeniently(this.dataDir));
      return stored === null ? null : assembleCard(id, stored.files, stored.rank);
    });
  }

  create(card: Card): Promise<boolean> {
    return settle(() => {
      // 読めない card.md でもディレクトリがあれば既存とみなし、上書きしない
      if (!isCardId(card.id) || fs.existsSync(this.cardDir(card.id))) return false;

      this.write(null, card);
      return true;
    });
  }

  save(card: Card): Promise<boolean> {
    return settle(() => {
      if (!isCardId(card.id)) return false;

      const stored = this.readStored(card.id, readOrderLeniently(this.dataDir));
      if (stored === null) return false;

      this.write(stored, card);
      return true;
    });
  }

  appendReview(id: CardId, entry: ReviewEntry): Promise<boolean> {
    return settle(() => {
      if (!isCardId(id)) return false;

      const stored = this.readStored(id, readOrderLeniently(this.dataDir));
      if (stored === null) return false;

      const planned = planReviewAppend(id, stored, entry);
      if (isErr(planned)) throw new CardWriteRefusedError(planned.error);

      const logDir = path.join(this.cardDir(id), LOG_DIR);
      fs.mkdirSync(logDir, { recursive: true });
      // 判断のファイルは追記だけ。既にあれば書き換えずに失敗する
      fs.writeFileSync(path.join(logDir, planned.value.name), planned.value.content, {
        flag: 'wx',
      });

      this.onWrite();
      return true;
    });
  }

  /** `planCardWrite` が求めたファイルを書く。拒まれたら何も書かずに例外を投げる */
  private write(stored: StoredCard | null, card: Card): void {
    const planned = planCardWrite(stored, card, this.now().toISOString());
    if (isErr(planned)) throw new CardWriteRefusedError(planned.error);

    const { cardMd, logFiles, rankChanged } = planned.value;
    // order.yaml が壊れていれば、カードのファイルを書く前に拒む
    const order = rankChanged ? readOrderStrictly(this.dataDir) : null;

    const dir = this.cardDir(card.id);
    if (cardMd !== null) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, CARD_FILE), cardMd);
    }

    if (logFiles.length > 0) {
      const logDir = path.join(dir, LOG_DIR);
      fs.mkdirSync(logDir, { recursive: true });
      // 判断のファイルは追記だけ。既にあれば書き換えずに失敗する
      for (const file of logFiles) {
        fs.writeFileSync(path.join(logDir, file.name), file.content, { flag: 'wx' });
      }
    }

    if (order !== null) {
      writeOrder(this.dataDir, withRank(order, card.id, card.rank));
    }

    if (cardMd !== null || logFiles.length > 0 || order !== null) {
      this.onWrite();
    }
  }

  /** 1 枚のカードのファイルを読む。`card.md` が無ければ null */
  private readStored(id: string, order: OrderFile): StoredCard | null {
    const dir = this.cardDir(id);
    const cardMd = readFileOrNull(path.join(dir, CARD_FILE));
    if (cardMd === null) {
      if (fs.existsSync(dir)) {
        console.warn(
          `[ai-board] カードを読み飛ばしました: ${CARDS_DIR}/${id} — ${CARD_FILE} がありません`
        );
      }
      return null;
    }

    return {
      files: { cardMd, log: readLogFiles(path.join(dir, LOG_DIR)) },
      rank: order.ranks[id] ?? null,
    };
  }

  /** `cards/` の下のディレクトリのうち、名前が ID として正しいもの */
  private listCardIds(): string[] {
    const cardsDir = path.join(this.dataDir, CARDS_DIR);
    if (!fs.existsSync(cardsDir)) return [];

    return fs
      .readdirSync(cardsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => {
        if (isCardId(name)) return true;
        console.warn(
          `[ai-board] カードを読み飛ばしました: ${CARDS_DIR}/${name} — ID として不正な名前です`
        );
        return false;
      });
  }

  private cardDir(id: string): string {
    return path.join(this.dataDir, CARDS_DIR, id);
  }
}

// ============================================================
// order.yaml の読み書き — 区切り線のリポジトリと共有する
// ============================================================

/**
 * 読み出し用。`order.yaml` が壊れていれば警告して空とみなす（1 つのファイルでボード全体を止めない）。
 * 書き戻すと全カードの rank を失うので、書き込みには使わない。
 */
export function readOrderLeniently(dataDir: string): OrderFile {
  const parsed = parseOrder(readFileOrNull(path.join(dataDir, ORDER_FILE)));
  if (!isErr(parsed)) return parsed.value;

  console.warn(
    `[ai-board] ${ORDER_FILE} を読めないため、並び順を空とみなします: ${parsed.error.reason}`
  );
  return EMPTY_ORDER;
}

/** 書き込み用。`order.yaml` が壊れていれば、書き戻さずに例外を投げる */
export function readOrderStrictly(dataDir: string): OrderFile {
  const parsed = parseOrder(readFileOrNull(path.join(dataDir, ORDER_FILE)));
  if (isErr(parsed)) throw new CardWriteRefusedError(parsed.error);

  return parsed.value;
}

export function writeOrder(dataDir: string, order: OrderFile): void {
  fs.writeFileSync(path.join(dataDir, ORDER_FILE), serializeOrder(order));
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

function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * `log/` のファイルだけを読む。ディレクトリは読まない。
 *
 * サーバはロックを取らずに読むので、読む間に取り直しや CLI の書き込みが `reset --hard` / `clean` で
 * `log/` やその中のファイルを消すことがある。消えたもの（ENOENT）は読み飛ばし、ボード全体を 500 にしない。
 */
function readLogFiles(logDir: string): LogFile[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile())
    .flatMap((entry) => {
      const content = readFileOrNull(path.join(logDir, entry.name));
      return content === null ? [] : [{ name: entry.name, content }];
    });
}
