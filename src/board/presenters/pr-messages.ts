import { describeCliError, type CliError } from '../../infrastructure/cli-runner.js';

// ============================================================
// GitHub（`gh`）への問い合わせの失敗を、人に読ませる 1 行にする
// ============================================================

/**
 * 失敗の 1 行。HTTP のステータスが分かれば添える。
 * stderr の本文は資格情報が混じりうるので載せない（`cli-runner.ts` の方針のまま）。
 */
export function describePrError(error: CliError): string {
  const message = describeCliError(error);

  return error.type === 'Failed' && error.httpStatus !== null
    ? `${message}（HTTP ${error.httpStatus}）`
    : message;
}
