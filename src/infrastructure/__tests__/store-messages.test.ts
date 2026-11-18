import { describe, expect, it } from 'vitest';
import type { StoreError } from '../document-store.js';
import { describeStoreError } from '../store-messages.js';

describe('describeStoreError', () => {
  const cases: StoreError[] = [
    { type: 'StoreNotConfigured' },
    { type: 'StoreNotPulled', mirrorDir: '/x/mirror' },
    { type: 'StoreUninitialized' },
    { type: 'StoreVersionMismatch', found: 2, expected: 3 },
    { type: 'StorePendingWrites', count: 2 },
    { type: 'StoreLockTimeout', lockPath: '/x/store.lock' },
    { type: 'StoreInvalidDocument', path: '/x/a.json', reason: '読めない' },
  ];

  it.each(cases)('$type を 1 行にする', (error) => {
    const message = describeStoreError(error);
    expect(message).not.toContain('\n');
    expect(message.length).toBeGreaterThan(0);
  });

  it('送っていない書き込みには件数と捨て方を書く', () => {
    expect(describeStoreError({ type: 'StorePendingWrites', count: 2 })).toContain(
      'ai-board store discard'
    );
  });

  it('形の版の食い違いには両方の版を書く', () => {
    const message = describeStoreError({ type: 'StoreVersionMismatch', found: 2, expected: 3 });
    expect(message).toContain('2');
    expect(message).toContain('3');
  });
});
