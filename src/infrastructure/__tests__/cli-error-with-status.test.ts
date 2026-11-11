import { describe, it, expect } from 'vitest';
import { describeCliErrorWithStatus } from '../cli-runner.js';

describe('describeCliErrorWithStatus', () => {
  it('HTTP のステータスが分かれば添える', () => {
    expect(
      describeCliErrorWithStatus({
        type: 'Failed',
        command: 'gh',
        message: '失敗',
        httpStatus: 422,
      })
    ).toBe('gh の失敗（HTTP 422）');
  });

  it('HTTP のステータスが分からなければ添えない', () => {
    expect(
      describeCliErrorWithStatus({
        type: 'Failed',
        command: 'gh',
        message: '失敗',
        httpStatus: null,
      })
    ).toBe('gh の失敗');
  });

  it('コマンドが無いときは、そう書く', () => {
    expect(describeCliErrorWithStatus({ type: 'NotInstalled', command: 'gh' })).toBe(
      'gh が見つからない'
    );
  });
});
