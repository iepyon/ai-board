// ============================================================
// Result type - Functional error handling
// ============================================================

/** 成功を表す結果 */
export type Ok<T> = {
  readonly ok: true;
  readonly value: T;
};

/** 失敗を表す結果 */
export type Err<E> = {
  readonly ok: false;
  readonly error: E;
};

/** 成功か失敗のいずれかを表す */
export type Result<T, E> = Ok<T> | Err<E>;

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}

/** Ok のとき値を変換する。Err はそのまま通す */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Ok のとき次の Result を返す関数へつなぐ */
export function flatMap<T, U, E>(
  result: Result<T, E>,
  fn: (value: T) => Result<U, E>
): Result<U, E> {
  return result.ok ? fn(result.value) : result;
}
