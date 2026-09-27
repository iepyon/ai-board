// ============================================================
// 適用済みの変更ファイルのリポジトリのインターフェース
// ============================================================

/**
 * どの変更ファイルを DB に適用したかを、ファイル名で記録する。
 * 記録は DB ごと（ワークツリーごと）に持つ。
 */
export interface AppliedChangeRepository {
  names(): Promise<Set<string>>;
  record(names: readonly string[], at: Date): Promise<void>;
  /**
   * `fn` の中の DB への書き込みを 1 つのトランザクションにする。
   * 変更の反映と適用済みの記録を、どちらか片方だけ残さないため。
   */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}
