import type { ErrorRequestHandler, RequestHandler } from 'express';

// ============================================================
// エラーハンドリングミドルウェア
// ============================================================

/**
 * 想定外の例外を 500 に変換する。
 * スタックトレースはレスポンスに含めない。
 */
export const errorHandlerMiddleware: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  console.error('[ai-board] unhandled error:', error);

  res.status(500).json({
    code: 'INTERNAL_ERROR',
    message: '内部エラーが発生しました。サーバのログを確認してください。',
  });
};

/** 未定義の /api/* パスを 404 にする */
export const notFoundMiddleware: RequestHandler = (_req, res) => {
  res.status(404).json({ code: 'NOT_FOUND', message: 'エンドポイントが見つかりません。' });
};
