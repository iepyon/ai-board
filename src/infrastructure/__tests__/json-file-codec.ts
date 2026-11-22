import type { Collection, DocumentData } from '../document-store.js';
import type { DocumentFileCodec } from '../git-document-store.js';

/**
 * 文書を `<root>/<collection>/<id>.json` に置くコーデック。文書の形を問わない契約テストに使う。
 * `snapshots` と `loop` は本物（`cardFileCodec`）と同じく手元に置く
 */
export function jsonFileCodec(root: string): DocumentFileCodec {
  const prefix = `${root}/`;
  const isDocumentFile = (filePath: string): boolean =>
    filePath.startsWith(prefix) && filePath.endsWith('.json');
  return {
    roots: [root],
    localCollections: ['snapshots', 'loop'],
    isDocumentFile,
    toDocument(filePath, content) {
      if (!isDocumentFile(filePath)) return null;
      const [collection, name, ...rest] = filePath.slice(prefix.length).split('/');
      if (collection === undefined || name === undefined || rest.length > 0) return null;
      try {
        return {
          collection: collection as Collection,
          id: name.slice(0, -'.json'.length),
          data: JSON.parse(content) as DocumentData,
        };
      } catch {
        return null;
      }
    },
    toFile(collection, id, data) {
      return { path: `${prefix}${collection}/${id}.json`, content: `${JSON.stringify(data)}\n` };
    },
  };
}
