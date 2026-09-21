import { useMemo, useState } from 'react';
import { useBoard } from './hooks/useBoard.js';
import { Board } from './components/Board.js';
import { CardDetail } from './components/CardDetail.js';
import { NewCardDialog } from './components/NewCardDialog.js';
import type { Board as BoardData, ForgeConnection, ForgeKind } from './types.js';

// ============================================================
// ai-board アプリケーション
// ============================================================

export function App() {
  const { board, error, loading, reload } = useBoard();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [showAborted, setShowAborted] = useState(false);

  // ボードを取り直すたびに選択中のカードも最新の状態にする
  const selected = useMemo(
    () => board?.cards.find((card) => card.id === selectedId) ?? null,
    [board, selectedId]
  );

  const orphanChanges = board?.orphanChanges ?? [];

  const { visible, abortedCount } = useMemo(
    () => splitAborted(board, showAborted),
    [board, showAborted]
  );

  return (
    <div className="app">
      <TopBar
        cardCount={visible?.cards.length ?? null}
        forge={board?.forge ?? null}
        abortedCount={abortedCount}
        showAborted={showAborted}
        onToggleAborted={() => setShowAborted((on) => !on)}
        onAdd={() => setAdding(true)}
        onReload={reload}
      />

      <Banners error={error} actionError={actionError} orphanChanges={orphanChanges} />

      {loading && <p className="empty">読み込み中…</p>}

      {visible !== null && (
        <Board
          board={visible}
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

/**
 * 中止されたカードを畳んだビューと、畳んだ件数。
 *
 * 列は増やさない。マージ済みとは意味が違うので同じ列に混ぜられないが、
 * 終端であることは変わらないため、既定では見えない場所へ置く。
 */
function splitAborted(
  board: BoardData | null,
  showAborted: boolean
): { visible: BoardData | null; abortedCount: number } {
  if (board === null) {
    return { visible: null, abortedCount: 0 };
  }

  const aborted = board.cards.filter((card) => card.aborted);
  const cards = showAborted ? board.cards : board.cards.filter((card) => !card.aborted);

  return { visible: { ...board, cards }, abortedCount: aborted.length };
}

interface BannersProps {
  error: string | null;
  actionError: string | null;
  orphanChanges: readonly string[];
}

function Banners({ error, actionError, orphanChanges }: BannersProps) {
  return (
    <>
      {error !== null && <div className="banner error">ボードを読み込めません: {error}</div>}
      {actionError !== null && <div className="banner error">{actionError}</div>}

      {orphanChanges.length > 0 && (
        <div className="banner info">
          カードに紐付いていない change: {orphanChanges.join(', ')}
          （カード詳細の change 欄で紐付けられます）
        </div>
      )}
    </>
  );
}

interface TopBarProps {
  cardCount: number | null;
  forge: ForgeConnection | null;
  abortedCount: number;
  showAborted: boolean;
  onToggleAborted: () => void;
  onAdd: () => void;
  onReload: () => void;
}

function TopBar({
  cardCount,
  forge,
  abortedCount,
  showAborted,
  onToggleAborted,
  onAdd,
  onReload,
}: TopBarProps) {
  return (
    <header className="topbar">
      <h1>ai-board</h1>
      <span className="status">{cardCount === null ? '' : `${cardCount} cards`}</span>
      <span className="spacer" />
      {abortedCount > 0 && (
        <button type="button" className="btn ghost" onClick={onToggleAborted}>
          {showAborted ? `中止 ${abortedCount} 件を隠す` : `中止 ${abortedCount} 件を表示`}
        </button>
      )}
      {forge !== null && <ForgeStatus connection={forge} />}
      <button type="button" className="btn" onClick={onAdd}>
        ＋ アイデア
      </button>
      <button type="button" className="btn ghost" onClick={onReload}>
        再読み込み
      </button>
    </header>
  );
}

const FORGE_LABELS: Record<ForgeKind, string> = { gitlab: 'GitLab', github: 'GitHub' };

function ForgeStatus({ connection }: { connection: ForgeConnection }) {
  switch (connection.status) {
    case 'connected':
      return <span className="status connected">{FORGE_LABELS[connection.kind]} 接続中</span>;
    case 'disabled':
      return <span className="status disabled">{describeDisabled(connection)}</span>;
    case 'error':
      return (
        <span className="status error">
          {FORGE_LABELS[connection.kind]} 未接続: {connection.message}
        </span>
      );
  }
}

/** 未設定なのか、設定はあるが CLI が使えないのかを見分けられるようにする */
function describeDisabled(connection: Extract<ForgeConnection, { status: 'disabled' }>): string {
  if (connection.kind === null) return '取得先 未設定';

  const label = FORGE_LABELS[connection.kind];

  return connection.reason === null ? `${label} 未設定` : `${label} 利用不可: ${connection.reason}`;
}
