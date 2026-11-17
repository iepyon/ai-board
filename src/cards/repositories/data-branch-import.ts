import * as fs from 'node:fs';
import * as path from 'node:path';
import { isErr, err, ok, type Result } from '../../shared/result.js';
import { CardIdSchema } from '../../shared/schemas/common.js';
import { isRetiredReviewGate } from '../models/review.js';
import type { Collection, DocumentData } from '../../infrastructure/document-store.js';
import {
  CARDS_DIR,
  CARD_COLLECTION,
  CARD_FILE,
  DATA_VERSION_FILE,
  LOG_COLLECTION,
  LOG_DIR,
  ORDER_COLLECTION,
  ORDER_FILE,
  ORDER_ID,
  cardDocumentFromMarkdown,
  logDocumentData,
  logDocumentId,
  orderDocumentData,
  parseDataVersion,
  parseLogFileName,
  parseOrder,
} from './card-files.js';

// ============================================================
// データ用ブランチ（形の版 2）から移す — `ai-board store import` が読む
// ============================================================

/** 移す文書 1 つ */
export interface ImportDocument {
  readonly collection: Collection;
  readonly id: string;
  readonly data: DocumentData;
}

/**
 * データ用ブランチの clone（`ai-board/data` を checkout したディレクトリ）を読み、移す文書を返す。
 *
 * 移すのはカード（`card.md`）・判断（`log/`）・並び順と区切り線（`order.yaml`）だけ。
 * マージ済みの PR の控え（`snapshots/`）は GitHub から引き直し、ループの記録（`loop/`）は見るためのものなので移さない。
 * 形の版（`ai-board-data.yaml`）が 2 でなければ読まない。読めないカードと判断は警告して読み飛ばす
 * （廃止したゲートの判断は警告せずに飛ばす）。
 */
export function readDataBranchDocuments(dir: string): Result<ImportDocument[], string> {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return err(`${dir} がありません`);
  }

  const versionRaw = readFileOrNull(path.join(dir, DATA_VERSION_FILE));
  if (versionRaw === null)
    return err(`${DATA_VERSION_FILE} がありません。データ用ブランチの clone を指してください`);
  const version = parseDataVersion(versionRaw);
  if (isErr(version)) {
    return err(
      version.error.type === 'UnsupportedDataVersion'
        ? `データ用ブランチの形の版が ${version.error.found} です（移せるのは ${version.error.supported}）`
        : version.error.reason
    );
  }

  const order = parseOrder(readFileOrNull(path.join(dir, ORDER_FILE)));
  if (isErr(order)) return err(`${ORDER_FILE} が読めません: ${order.error.reason}`);

  const docs: ImportDocument[] = [
    { collection: ORDER_COLLECTION, id: ORDER_ID, data: orderDocumentData(order.value) },
  ];

  for (const id of listCardDirs(path.join(dir, CARDS_DIR))) {
    docs.push(...readCard(path.join(dir, CARDS_DIR), id));
  }

  return ok(docs);
}

/** `cards/` の下のディレクトリの名前 */
function listCardDirs(cardsDir: string): string[] {
  if (!fs.existsSync(cardsDir)) return [];
  return fs
    .readdirSync(cardsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/** 1 枚のカードの文書と判断の文書。読めなければ警告して空 */
function readCard(cardsDir: string, id: string): ImportDocument[] {
  if (!CardIdSchema.safeParse(id).success) {
    console.warn(`[ai-board] 移さずに飛ばしました: ${CARDS_DIR}/${id} — ID として不正な名前です`);
    return [];
  }
  const cardMd = readFileOrNull(path.join(cardsDir, id, CARD_FILE));
  const card = cardMd === null ? null : cardDocumentFromMarkdown(id, cardMd);
  if (card === null) {
    console.warn(`[ai-board] 移さずに飛ばしました: ${CARDS_DIR}/${id}/${CARD_FILE} — 読めません`);
    return [];
  }

  const docs: ImportDocument[] = [{ collection: CARD_COLLECTION, id, data: { ...card } }];
  const logDir = path.join(cardsDir, id, LOG_DIR);
  if (!fs.existsSync(logDir)) return docs;

  for (const name of fs.readdirSync(logDir).sort()) {
    if (parseLogFileName(name) === null) {
      warnUnreadableLog(id, name);
      continue;
    }
    const content = fs.readFileSync(path.join(logDir, name), 'utf-8');
    docs.push({
      collection: LOG_COLLECTION,
      id: logDocumentId(id, name),
      data: logDocumentData(id, { name, content }),
    });
  }
  return docs;
}

/** 読めない判断のファイルを警告する。廃止したゲートのものは壊れていないので黙って飛ばす */
function warnUnreadableLog(id: string, name: string): void {
  const gate = /^[^.]+\.[^.]+\.([a-z]+)\./.exec(name)?.[1];
  if (gate !== undefined && isRetiredReviewGate(gate)) return;
  console.warn(`[ai-board] 移さずに飛ばしました: ${CARDS_DIR}/${id}/${LOG_DIR}/${name}`);
}

function readFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
