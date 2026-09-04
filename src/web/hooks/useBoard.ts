import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchBoard } from '../api.js';
import type { Board } from '../types.js';

// ============================================================
// ボードの購読
// ============================================================

interface UseBoardResult {
  board: Board | null;
  error: string | null;
  /** 初回ロード中か。再取得中はカードを消さないため false のまま */
  loading: boolean;
  reload: () => void;
}

/**
 * ボードを取得し、SSE でファイル変更・ポーリング結果を受けて取り直す。
 *
 * サーバが送るのはイベント名だけなので、受け取ったらこちらで
 * `/api/board` を引き直す。
 */
export function useBoard(): UseBoardResult {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const inFlight = useRef(false);

  const reload = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;

    fetchBoard()
      .then((next) => {
        setBoard(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        inFlight.current = false;
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    reload();

    const source = new EventSource('/api/events');
    source.addEventListener('board-changed', reload);

    return () => {
      source.removeEventListener('board-changed', reload);
      source.close();
    };
  }, [reload]);

  return { board, error, loading, reload };
}
