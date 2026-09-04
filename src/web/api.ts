import type { Board, BoardCard, Stage } from './types.js';

// ============================================================
// API クライアント
// ============================================================

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `リクエストに失敗しました (${response.status})`);
  }

  return (await response.json()) as T;
}

export function fetchBoard(): Promise<Board> {
  return request<Board>('/api/board');
}

export function createCard(input: {
  title: string;
  id?: string;
  body?: string;
}): Promise<BoardCard> {
  return request<BoardCard>('/api/cards', { method: 'POST', body: JSON.stringify(input) });
}

export interface CardMetaPatch {
  title?: string;
  explored?: boolean;
  implStartedAt?: string | null;
  change?: string | null;
  branch?: string | null;
  mr?: number | null;
  stageOverride?: Stage | null;
}

export function updateCardMeta(id: string, patch: CardMetaPatch): Promise<BoardCard> {
  return request<BoardCard>(`/api/cards/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function updateCardBody(id: string, body: string): Promise<BoardCard> {
  return request<BoardCard>(`/api/cards/${encodeURIComponent(id)}/body`, {
    method: 'PUT',
    body: JSON.stringify({ body }),
  });
}
