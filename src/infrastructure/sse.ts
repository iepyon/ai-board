import type { Request, Response, RequestHandler } from 'express';

// ============================================================
// Server-Sent Events
// ============================================================

const HEARTBEAT_INTERVAL_MS = 25_000;

/**
 * ファイル変更と GitHub ポーリング結果をブラウザへ push する。
 *
 * 送るのはイベント名だけで、ボードの中身は含めない。
 * 受け取ったブラウザが `/api/board` を取り直す。
 */
export class SseHub {
  private readonly clients = new Set<Response>();
  private heartbeat: NodeJS.Timeout | null = null;

  handler(): RequestHandler {
    return (req: Request, res: Response): void => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });

      // ヘッダ送出直後に切断されていることがある。
      // ここで例外を漏らすとルートハンドラごと落ちるので握る。
      try {
        res.write('retry: 3000\n\n');
      } catch {
        return;
      }

      this.clients.add(res);
      this.ensureHeartbeat();

      req.on('close', () => {
        this.clients.delete(res);
        this.stopHeartbeatIfIdle();
      });
    };
  }

  /** 全クライアントへ通知する。切断済みのクライアントは取り除く */
  broadcast(event: string): void {
    const payload = `event: ${event}\ndata: {}\n\n`;

    for (const client of this.clients) {
      try {
        client.write(payload);
      } catch {
        this.clients.delete(client);
      }
    }
  }

  close(): void {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    this.stopHeartbeatIfIdle();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /** プロキシに接続を切られないよう定期的にコメント行を送る */
  private ensureHeartbeat(): void {
    if (this.heartbeat !== null) return;

    this.heartbeat = setInterval(() => {
      for (const client of this.clients) {
        try {
          client.write(': heartbeat\n\n');
        } catch {
          this.clients.delete(client);
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref?.();
  }

  private stopHeartbeatIfIdle(): void {
    if (this.clients.size === 0 && this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}
