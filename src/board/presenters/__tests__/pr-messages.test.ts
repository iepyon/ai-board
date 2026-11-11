import { describe, it, expect } from 'vitest';
import { describePrError } from '../pr-messages.js';

describe('describePrError', () => {
  it('HTTP のステータスが分かれば添える', () => {
    expect(
      describePrError({ type: 'Failed', command: 'gh', message: '失敗', httpStatus: 422 })
    ).toBe('gh の失敗（HTTP 422）');
  });

  it('HTTP のステータスが分からなければ添えない', () => {
    expect(
      describePrError({ type: 'Failed', command: 'gh', message: '失敗', httpStatus: null })
    ).toBe('gh の失敗');
  });

  it('コマンドが無いときは、そう書く', () => {
    expect(describePrError({ type: 'NotInstalled', command: 'gh' })).toBe('gh が見つからない');
  });
});
