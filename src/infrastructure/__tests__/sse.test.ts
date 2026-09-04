import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { SseHub } from '../sse.js';

// ============================================================
// テストダブル
// ============================================================

interface FakeResponse extends Response {
  written: string[];
  ended: boolean;
}

function fakeResponse(onWrite?: () => void): FakeResponse {
  const written: string[] = [];

  return {
    written,
    ended: false,
    writeHead: vi.fn(),
    write: vi.fn((chunk: string) => {
      onWrite?.();
      written.push(chunk);
      return true;
    }),
    end: vi.fn(function (this: FakeResponse) {
      this.ended = true;
    }),
  } as unknown as FakeResponse;
}

function fakeRequest(): { req: Request; close: () => void } {
  const handlers: Array<() => void> = [];

  const req = {
    on: (event: string, handler: () => void) => {
      if (event === 'close') handlers.push(handler);
    },
  } as unknown as Request;

  return { req, close: () => handlers.forEach((handler) => handler()) };
}

// ============================================================

describe('SseHub', () => {
  it('接続時にストリームのヘッダと retry を送る', () => {
    const hub = new SseHub();
    const res = fakeResponse();
    const { req } = fakeRequest();

    hub.handler()(req, res, vi.fn());

    expect(res.writeHead).toHaveBeenCalledWith(
      200,
      expect.objectContaining({ 'Content-Type': 'text/event-stream' })
    );
    expect(res.written[0]).toBe('retry: 3000\n\n');
    expect(hub.clientCount).toBe(1);

    hub.close();
  });

  it('接続中の全クライアントにイベントを配る', () => {
    const hub = new SseHub();
    const first = fakeResponse();
    const second = fakeResponse();
    hub.handler()(fakeRequest().req, first, vi.fn());
    hub.handler()(fakeRequest().req, second, vi.fn());

    hub.broadcast('board-changed');

    expect(first.written).toContain('event: board-changed\ndata: {}\n\n');
    expect(second.written).toContain('event: board-changed\ndata: {}\n\n');

    hub.close();
  });

  it('切断されたクライアントを取り除く', () => {
    const hub = new SseHub();
    const { req, close } = fakeRequest();
    hub.handler()(req, fakeResponse(), vi.fn());
    expect(hub.clientCount).toBe(1);

    close();

    expect(hub.clientCount).toBe(0);
  });

  it('接続直後に切断されたクライアントは登録しない', () => {
    const hub = new SseHub();
    const broken = fakeResponse(() => {
      throw new Error('EPIPE');
    });

    // 初回書き込みで失敗する。例外を漏らすとルートごと落ちる
    expect(() => hub.handler()(fakeRequest().req, broken, vi.fn())).not.toThrow();
    expect(hub.clientCount).toBe(0);
  });

  it('配信中に書き込みが失敗したクライアントを取り除く', () => {
    const hub = new SseHub();
    let connected = false;
    const broken = fakeResponse(() => {
      if (connected) throw new Error('EPIPE');
    });
    hub.handler()(fakeRequest().req, broken, vi.fn());
    connected = true;
    expect(hub.clientCount).toBe(1);

    hub.broadcast('board-changed');

    expect(hub.clientCount).toBe(0);
  });

  it('close で全クライアントを終了させる', () => {
    const hub = new SseHub();
    const res = fakeResponse();
    hub.handler()(fakeRequest().req, res, vi.fn());

    hub.close();

    expect(res.ended).toBe(true);
    expect(hub.clientCount).toBe(0);
  });

  it('クライアントが居なければ broadcast は何もしない', () => {
    const hub = new SseHub();

    expect(() => hub.broadcast('board-changed')).not.toThrow();
  });
});
