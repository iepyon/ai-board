// ============================================================
// HTTP エラーレスポンスの共通形
// ============================================================

export interface ErrorResponse {
  readonly status: number;
  readonly response: {
    readonly code: string;
    readonly message: string;
  };
}
