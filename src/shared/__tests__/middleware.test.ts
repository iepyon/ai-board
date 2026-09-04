import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import {
  errorHandlerMiddleware,
  notFoundMiddleware,
} from '../middleware/error-handler.middleware.js';

function fakeResponse(headersSent = false): Response {
  const res = {
    headersSent,
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  } as unknown as Response & { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };

  return res;
}

afterEach(() => vi.restoreAllMocks());

describe('errorHandlerMiddleware', () => {
  it('例外を 500 に変換し、スタックトレースは返さない', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = fakeResponse();

    errorHandlerMiddleware(new Error('壊れた'), {} as Request, res, vi.fn() as NextFunction);

    expect(res.status).toHaveBeenCalledWith(500);
    const body = (res.json as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(body['code']).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(body)).not.toContain('stack');
    expect(JSON.stringify(body)).not.toContain('壊れた');
  });

  it('レスポンス送出済みなら next に委ねる', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const next = vi.fn();
    const error = new Error('遅れて壊れた');

    errorHandlerMiddleware(error, {} as Request, fakeResponse(true), next as NextFunction);

    expect(next).toHaveBeenCalledWith(error);
  });
});

describe('notFoundMiddleware', () => {
  it('404 を返す', () => {
    const res = fakeResponse();

    notFoundMiddleware({} as Request, res, vi.fn() as NextFunction);

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
