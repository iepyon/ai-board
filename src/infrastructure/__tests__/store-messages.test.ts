import { describe, expect, it } from 'vitest';
import type { StoreError } from '../document-store.js';
import { describeStoreError } from '../store-messages.js';

describe('describeStoreError', () => {
  const cases: StoreError[] = [
    { type: 'StoreUninitialized' },
    { type: 'StoreVersionMismatch', found: 2, expected: 3 },
    { type: 'StoreLockTimeout', lockPath: '/x/store.lock' },
    { type: 'StoreRemoteMissing', remote: 'origin' },
    { type: 'StoreGitFailed', operation: 'fetch', message: 'Command failed: git fetch' },
    { type: 'StorePushConflict', attempts: 3 },
    { type: 'StoreAlreadyInitialized' },
  ];

  it.each(cases)('$type を 1 行にする', (error) => {
    const message = describeStoreError(error);
    expect(message).not.toContain('\n');
    expect(message.length).toBeGreaterThan(0);
  });

  it('リモートが無ければ足し方と設定の場所を書く', () => {
    const message = describeStoreError({ type: 'StoreRemoteMissing', remote: 'origin' });
    expect(message).toContain('origin');
    expect(message).toContain('store.remote');
  });

  it('形の版の食い違いには両方の版を書く', () => {
    const message = describeStoreError({ type: 'StoreVersionMismatch', found: 2, expected: 3 });
    expect(message).toContain('2');
    expect(message).toContain('3');
  });
});
