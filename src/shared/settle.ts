// ============================================================
// 同期の処理を Promise にする
// ============================================================

/** 同期の処理を Promise にする。投げた例外は reject として返す（リポジトリの口が Promise を返すため） */
export function settle<T>(fn: () => T): Promise<T> {
  return new Promise((resolve) => resolve(fn()));
}
