import { useMemo, useState } from 'react';
import { useBoard } from './hooks/useBoard.js';
import { Board } from './components/Board.js';
import { CardDetail } from './components/CardDetail.js';
import { NewCardDialog } from './components/NewCardDialog.js';
import type { GitLabConnection } from './types.js';

// ============================================================
// ai-board アプリケーション
// ============================================================

export function App() {
  const { board, error, loading, reload } = useBoard();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // ボードを取り直すたびに選択中のカードも最新の状態にする
  const selected = useMemo(
    () => board?.cards.find((card) => card.id === selectedId) ?? null,
    [board, selectedId]
  );

  return (
    <div className="app">
      <header className="topbar">
        <h1>ai-board</h1>
        <span className="status">{board === null ? '' : `${board.cards.length} cards`}</span>
        <span className="spacer" />
        {board !== null && <GitLabStatus connection={board.gitlab} />}
        <button type="button" className="btn" onClick={() => setAdding(true)}>
          ＋ アイデア
        </button>
        <button type="button" className="btn ghost" onClick={reload}>
          再読み込み
        </button>
      </header>

      {error !== null && <div className="banner error">ボードを読み込めません: {error}</div>}
      {actionError !== null && <div className="banner error">{actionError}</div>}

      {board !== null && board.orphanChanges.length > 0 && (
        <div className="banner info">
          カードに紐付いていない change: {board.orphanChanges.join(', ')}
          （カード詳細の change 欄で紐付けられます）
        </div>
      )}

      {loading && <p className="empty">読み込み中…</p>}

      {board !== null && (
        <Board
          board={board}
          selectedId={selectedId}
          onSelect={(card) => setSelectedId(card.id)}
          onChanged={reload}
          onAddCard={() => setAdding(true)}
          onError={setActionError}
        />
      )}

      {selected !== null && board !== null && (
        <CardDetail card={selected} onClose={() => setSelectedId(null)} onChanged={reload} />
      )}

      {adding && <NewCardDialog onClose={() => setAdding(false)} onCreated={reload} />}
    </div>
  );
}

function GitLabStatus({ connection }: { connection: GitLabConnection }) {
  switch (connection.status) {
    case 'connected':
      return <span className="status connected">GitLab 接続中</span>;
    case 'disabled':
      return <span className="status disabled">GitLab 未設定</span>;
    case 'error':
      return <span className="status error">GitLab 未接続: {connection.message}</span>;
  }
}
