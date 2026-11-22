import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { DocumentFileCodec } from '../../infrastructure/git-document-store.js';
import { META_COLLECTION, META_ID } from '../../infrastructure/document-store.js';
import { CardIdSchema } from '../../shared/schemas/common.js';
import {
  CARD_COLLECTION,
  CARD_FILE,
  CARDS_DIR,
  LOG_COLLECTION,
  LOG_DIR,
  ORDER_COLLECTION,
  ORDER_FILE,
  ORDER_ID,
  cardDocumentFromMarkdown,
  cardIdOfLogDocument,
  cardMarkdownFromDocument,
  isRetiredLogFileName,
  logDocumentData,
  logDocumentId,
  logFileFromDocument,
  parseLogFileName,
} from './card-files.js';

// ============================================================
// git の置き場所のファイルの形 — 文書と `.ai-board/` のファイルの行き来
// ============================================================

/**
 * git の置き場所（`GitDocumentStore`）に、カード・判断・並び順・形の版を次のファイルで置く。
 *
 * ```
 * .ai-board/board.yaml                              board/meta（形の版）
 * .ai-board/order.yaml                              order/order（rank とアイデアの区切り線）
 * .ai-board/cards/<id>/card.md                      cards/<id>（frontmatter と本文）
 * .ai-board/cards/<id>/log/<時刻>.<gate>.<種別>.md  log/<id>.<名前>（判断・着手 1 件。中身は理由）
 * ```
 *
 * `card.md` と判断のファイルの形は `card-files.ts`（以前のデータ用ブランチの形）をそのまま使う。
 * 計画（`cards/<id>/plan.md`）は置き場所の文書ではないので読まない（カードのブランチから PR でマージされる）。
 * 読めないファイルは警告して読み飛ばす（1 枚でボード全体を止めない）。
 */
export const BOARD_ROOT = '.ai-board';
export const BOARD_META_FILE = 'board.yaml';

const META_PATH = `${BOARD_ROOT}/${BOARD_META_FILE}`;
const ORDER_PATH = `${BOARD_ROOT}/${ORDER_FILE}`;
const CARDS_PATH = `${BOARD_ROOT}/${CARDS_DIR}`;

/** 置き場所のファイルか（`board.yaml`・`order.yaml`・`card.md`・`log/` の下）。カードのブランチの検査に使う */
export function isStoreFilePath(filePath: string): boolean {
  if (filePath === META_PATH || filePath === ORDER_PATH) return true;
  const rest = cardRelative(filePath);
  if (rest === null) return false;
  return rest.file === CARD_FILE || rest.file.startsWith(`${LOG_DIR}/`);
}

export const cardFileCodec: DocumentFileCodec = {
  roots: [META_PATH, ORDER_PATH, CARDS_PATH],

  toDocument(filePath, content) {
    if (filePath === META_PATH) {
      // 読めなければ版の無い形の版として渡し、形の版の確かめ（`checkMeta`）で止める
      return {
        collection: META_COLLECTION,
        id: META_ID,
        data: readYamlObject(filePath, content) ?? {},
      };
    }
    if (filePath === ORDER_PATH) {
      // 壊れていても読み飛ばさない。読み流して書き戻すと全カードの rank を失うので、
      // 読めない中身のまま渡し、並び順を読む側（`parseOrderData`）に失敗させる
      return {
        collection: ORDER_COLLECTION,
        id: ORDER_ID,
        data: readYamlObject(filePath, content) ?? { divider: UNREADABLE },
      };
    }

    const rest = cardRelative(filePath);
    if (rest === null) return null;
    if (rest.file === CARD_FILE) {
      const doc = cardDocumentFromMarkdown(rest.id, content);
      return doc === null ? null : { collection: CARD_COLLECTION, id: rest.id, data: { ...doc } };
    }
    if (rest.file.startsWith(`${LOG_DIR}/`)) {
      const name = rest.file.slice(LOG_DIR.length + 1);
      if (name.includes('/') || isRetiredLogFileName(name)) return null;
      if (parseLogFileName(name) === null) {
        console.warn(`[ai-board] 判断のファイルを読み飛ばしました: ${filePath}`);
        return null;
      }
      return {
        collection: LOG_COLLECTION,
        id: logDocumentId(rest.id, name),
        data: logDocumentData(rest.id, { name, content }),
      };
    }
    return null;
  },

  toFile(collection, id, data) {
    switch (collection) {
      case 'board':
        return { path: META_PATH, content: stringifyYaml(data) };
      case 'order':
        return { path: ORDER_PATH, content: stringifyYaml(data) };
      case 'cards':
        return {
          path: `${CARDS_PATH}/${id}/${CARD_FILE}`,
          content: cardMarkdownFromDocument(data),
        };
      case 'log': {
        const cardId = cardIdOfLogDocument(id);
        const file = logFileFromDocument(cardId, id, data);
        return { path: `${CARDS_PATH}/${cardId}/${LOG_DIR}/${file.name}`, content: file.content };
      }
      default:
        // 手元に置くコレクション（snapshots / loop）は git の置き場所に来ない
        throw new Error(`git の置き場所に置かないコレクションです: ${collection}`);
    }
  },
};

/** `.ai-board/cards/<id>/<file>` を分ける。ID として不正なら警告して null */
function cardRelative(filePath: string): { id: string; file: string } | null {
  const prefix = `${CARDS_PATH}/`;
  if (!filePath.startsWith(prefix)) return null;
  const rest = filePath.slice(prefix.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const id = rest.slice(0, slash);
  if (!CardIdSchema.safeParse(id).success) {
    console.warn(`[ai-board] カード ID として不正なディレクトリを読み飛ばしました: ${filePath}`);
    return null;
  }
  return { id, file: rest.slice(slash + 1) };
}

/** 並び順を読む側（`parseOrderData`）が形の誤りとして拒む値 */
const UNREADABLE = 'order.yaml を読めません';

/** YAML のオブジェクトを読む。空なら空のオブジェクト。読めない・オブジェクトでないなら警告して null */
function readYamlObject(filePath: string, content: string): Record<string, unknown> | null {
  try {
    const data = parseYaml(content) as unknown;
    if (data === null || data === undefined) return {};
    if (typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {
    // 下で読めなかったことを表す中身にする
  }
  console.warn(`[ai-board] YAML として読めません: ${filePath}`);
  return null;
}
