import { describe, it, expect } from 'vitest';
import { failureScope, ForgeRequestError } from '../forge-client.js';
import type { CliError } from '../../../infrastructure/cli-runner.js';

function failed(httpStatus: number | null): CliError {
  return { type: 'Failed', command: 'gh', message: '終了コード 1 で失敗した', httpStatus };
}

describe('failureScope', () => {
  it.each([401, 403, 429, 500, 502, 503])('HTTP %i は全体に効く', (status) => {
    expect(failureScope(failed(status))).toBe('global');
  });

  it('HTTP のステータスが取れない失敗（ネットワークの断・タイムアウト）は全体に効く', () => {
    expect(failureScope(failed(null))).toBe('global');
  });

  it('CLI が無いのは全体に効く', () => {
    expect(failureScope({ type: 'NotInstalled', command: 'gh' })).toBe('global');
  });

  it.each([400, 409, 410, 422])('HTTP %i はそのカードだけに効く', (status) => {
    expect(failureScope(failed(status))).toBe('card');
  });

  it('JSON として読めない応答はそのカードだけに効く', () => {
    expect(
      failureScope({ type: 'InvalidJson', command: 'gh', message: 'JSON として読めなかった' })
    ).toBe('card');
  });
});

describe('ForgeRequestError', () => {
  it('問い合わせ先と HTTP のステータスで文を作る', () => {
    const error = new ForgeRequestError('pulls/68', failed(422));

    expect(error.message).toBe('pulls/68 が HTTP 422 で失敗した');
    expect(error.endpoint).toBe('pulls/68');
    expect(error.httpStatus).toBe(422);
    expect(error.scope).toBe('card');
  });

  it('クエリを落とす', () => {
    const error = new ForgeRequestError('pulls?head=owner%3Afeat&state=all', failed(422));

    expect(error.endpoint).toBe('pulls');
    expect(error.message).not.toContain('feat');
  });

  it('ステータスが無ければ CLI の失敗の文を添える', () => {
    const error = new ForgeRequestError('pulls/7', failed(null));

    expect(error.message).toBe('pulls/7 が失敗した（gh の終了コード 1 で失敗した）');
    expect(error.httpStatus).toBeNull();
  });
});
