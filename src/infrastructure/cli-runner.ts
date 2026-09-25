import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ok, err, isErr, type Result } from '../shared/result.js';

// ============================================================
// 外部 CLI の実行
// ============================================================

const execFileAsync = promisify(execFile);

/** 応答しない CLI がポーリングを止めないための上限 */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** 想定外に大きな応答でメモリを食わないための上限 */
export const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * CLI の実行が失敗した理由。
 *
 * `NotInstalled` と `Failed` を呼び出し側が区別できるようにしている。
 * 前者は「前提が満たされていない」、後者は「実行はできたが結果が得られなかった」で、
 * 利用者に出すべき文言が違うため。
 */
export type CliError =
  | { readonly type: 'NotInstalled'; readonly command: string }
  | {
      readonly type: 'Failed';
      readonly command: string;
      readonly message: string;
      /**
       * stderr から抜き出した HTTP ステータス。取れなければ null。
       *
       * 404 を「存在しない」として扱うために必要。stderr 本文は載せず、
       * 数字 3 桁だけを取り出すことで資格情報が混ざる余地を断つ。
       */
      readonly httpStatus: number | null;
    }
  | { readonly type: 'InvalidJson'; readonly command: string; readonly message: string };

export interface RunOptions {
  /** process.env に重ねる環境変数。取得先のホスト固定などに使う */
  readonly env?: Readonly<Record<string, string>>;
}

export interface CliRunner {
  /** stdout をそのまま返す */
  run(
    command: string,
    args: readonly string[],
    options?: RunOptions
  ): Promise<Result<string, CliError>>;
}

export interface CliRunnerOptions {
  readonly timeoutMs?: number;
  readonly maxBuffer?: number;
}

/**
 * `execFile` で CLI を実行する。
 *
 * **shell を介さない。** 引数は配列の要素として渡す。
 * ブランチ名などカードファイル由来の文字列をコマンド行へ連結すると、
 * カードを書ける者が任意のコマンドを実行できることになるため。
 */
export function createCliRunner(options: CliRunnerOptions = {}): CliRunner {
  return {
    async run(command, args, runOptions = {}) {
      try {
        const { stdout } = await execFileAsync(command, [...args], {
          timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
          // shell は使わない。既定が false であることに依存せず明示する
          shell: false,
          ...(runOptions.env === undefined ? {} : { env: { ...process.env, ...runOptions.env } }),
        });

        return ok(stdout);
      } catch (error) {
        return err(toCliError(command, error));
      }
    },
  };
}

function toCliError(command: string, error: unknown): CliError {
  if (isErrnoException(error) && error.code === 'ENOENT') {
    return { type: 'NotInstalled', command };
  }

  return {
    type: 'Failed',
    command,
    message: describe(error),
    httpStatus: extractHttpStatus(error),
  };
}

/** `gh: Not Found (HTTP 404)` のような stderr から数字だけを取り出す */
function extractHttpStatus(error: unknown): number | null {
  if (!(error instanceof Error) || !('stderr' in error)) return null;

  const stderr = (error as { stderr?: unknown }).stderr;
  if (typeof stderr !== 'string') return null;

  const match = /\(HTTP (\d{3})\)/.exec(stderr);
  const code = match?.[1];

  return code === undefined ? null : Number(code);
}

/** 呼び出し先が「存在しない」と答えたか */
export function isNotFound(error: CliError): boolean {
  return error.type === 'Failed' && error.httpStatus === 404;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

/**
 * 失敗の説明文を組み立てる。
 *
 * CLI の stderr には資格情報が混じり得るため、そのままは載せない。
 * 載せるのは終了コードと、CLI 名だけに切り詰めたメッセージ。
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return '実行に失敗した';

  const code = 'code' in error ? error.code : undefined;

  return typeof code === 'number' ? `終了コード ${code} で失敗した` : '実行に失敗した';
}

/** stdout の JSON をパースする。空出力・不正 JSON は例外ではなく Err にする */
export function parseJson<T>(command: string, stdout: string): Result<T, CliError> {
  const trimmed = stdout.trim();

  if (trimmed === '') {
    return err({ type: 'InvalidJson', command, message: '出力が空だった' });
  }

  try {
    return ok(JSON.parse(trimmed) as T);
  } catch {
    return err({ type: 'InvalidJson', command, message: 'JSON として読めなかった' });
  }
}

/** 接続状態などに出す、利用者向けの 1 行 */
export function describeCliError(error: CliError): string {
  switch (error.type) {
    case 'NotInstalled':
      return `${error.command} が見つからない`;
    case 'Failed':
      return `${error.command} の${error.message}`;
    case 'InvalidJson':
      return `${error.command} の${error.message}`;
  }
}

/**
 * CLI の結果を値へ開く。404 は「存在しない」として null、それ以外の失敗は例外。
 *
 * 取得先の実装が共有するため、どちらか一方のクライアントではなくここに置く。
 */
export function unwrap<T>(result: Result<T, CliError>): T | null {
  if (isErr(result)) {
    if (isNotFound(result.error)) return null;
    throw new Error(describeCliError(result.error));
  }

  return result.value;
}
