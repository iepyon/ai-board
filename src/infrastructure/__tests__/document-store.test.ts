import { describe, expect, it } from 'vitest';
import { err } from '../../shared/result.js';
import {
  checkMeta,
  initialDocuments,
  isValidDocumentId,
  MemoryDocumentStore,
  STORE_VERSION,
} from '../document-store.js';
import { describeDocumentStoreContract } from './document-store.contract.js';

describeDocumentStoreContract('メモリ', () => new MemoryDocumentStore(initialDocuments()));

describe('checkMeta', () => {
  it('board/meta が無ければ未初期化', () => {
    expect(checkMeta(new MemoryDocumentStore())).toEqual(err({ type: 'StoreUninitialized' }));
  });

  it('形の版が違えば読まない', () => {
    const store = new MemoryDocumentStore([
      { collection: 'board', id: 'meta', data: { version: 2 } },
    ]);
    expect(checkMeta(store)).toEqual(
      err({ type: 'StoreVersionMismatch', found: 2, expected: STORE_VERSION })
    );
  });
});

describe('isValidDocumentId', () => {
  it.each(['card-a', 'card.20261117T000000.000Z.plan.submit', 'a_b:c@d+e'])('%s は使える', (id) => {
    expect(isValidDocumentId(id)).toBe(true);
  });

  it.each(['', '.', '..', 'a~1', 'a/b', 'あ', 'a b'])('%s は使えない', (id) => {
    expect(isValidDocumentId(id)).toBe(false);
  });
});
