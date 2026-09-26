import { useMemo, useState } from 'react';
import { useBoard } from './hooks/useBoard.js';
import { Dashboard } from './components/dashboard/Dashboard.js';
import { PipelineStrip } from './components/dashboard/PipelineStrip.js';
import { CardDetail } from './components/CardDetail.js';
import { NewCardDialog } from './components/NewCardDialog.js';
import { formatDateTime } from './format.js';
import type { Board as BoardData, ForgeConnection, ForgeKind } from './types.js';

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
      <header className="head">
        <TopBar board={board} onAdd={() => setAdding(true)} onReload={reload} />
        {board !== null && <Pipeline board={board} />}
      </header>

      <Banners error={error} actionError={actionError} onDismiss={() => setActionError(null)} />

      {loading && <p className="empty">読み込み中…</p>}

      {board !== null && (
        <main>
          <Dashboard
            board={board}
            onSelect={(card) => setSelectedId(card.id)}
            onChanged={reload}
            onError={setActionError}
          />
          <Warnings board={board} />
        </main>
      )}

      {selected !== null && (
        <CardDetail
          key={selected.id}
          card={selected}
          onClose={() => setSelectedId(null)}
          onChanged={reload}
        />
      )}

      {adding && <NewCardDialog onClose={() => setAdding(false)} onCreated={reload} />}
    </div>
  );
}

/** 件数帯。中止は工程の外にあるので数えない */
function Pipeline({ board }: { board: BoardData }) {
  const cards = useMemo(() => board.cards.filter((card) => !card.aborted), [board]);

  return <PipelineStrip stages={board.stages} cards={cards} />;
}

interface BannersProps {
  error: string | null;
  actionError: string | null;
  onDismiss: () => void;
}

/** 読み込みと操作の失敗。すぐに気付く必要があるので上に出す */
function Banners({ error, actionError, onDismiss }: BannersProps) {
  return (
    <>
      {error !== null && <div className="banner error">ボードを読み込めません: {error}</div>}
      {actionError !== null && (
        <div className="banner error">
          {actionError}
          <button type="button" className="btn ghost sm" onClick={onDismiss}>
            閉じる
          </button>
        </div>
      )}
    </>
  );
}

/**
 * 急がないが放っておくと気付けない警告。ページ末尾の帯にまとめる。
 *
 * カードの無い計画は、カードを消したか名前を変えたときに残る。
 * 取得先の接続エラーでは PR中 / マージ済み の列が空になるので、理由をここに出す。
 */
function Warnings({ board }: { board: BoardData }) {
  const forgeError = board.forge.status === 'error' ? board.forge.message : null;

  if (board.orphanPlans.length === 0 && forgeError === null) return null;

  return (
    <div className="warnings">
      {board.orphanPlans.length > 0 && (
        <div className="warn-banner">
          <b>カードの無い計画 {board.orphanPlans.length} 件</b>
          <span className="mono">{board.orphanPlans.join(', ')}</span>
          <span>カードを消したか、名前を変えた可能性があります。</span>
        </div>
      )}
      {forgeError !== null && (
        <div className="warn-banner">
          <b>GitHub に接続できません</b>
          <span>{forgeError}</span>
          <span>PR中 / マージ済み の件数が実態より少なく出ます。</span>
        </div>
      )}
    </div>
  );
}

interface TopBarProps {
  board: BoardData | null;
  onAdd: () => void;
  onReload: () => void;
}

function TopBar({ board, onAdd, onReload }: TopBarProps) {
  return (
    <div className="topbar">
      <h1>ai-board</h1>
      <span className="spacer" />
      {board !== null && (
        <span className="updated" title={formatDateTime(board.generatedAt)}>
          {board.cards.length} cards
        </span>
      )}
      {board !== null && <ForgeStatus connection={board.forge} />}
      <button type="button" className="btn" onClick={onAdd}>
        ＋ アイデア
      </button>
      <button type="button" className="btn ghost" onClick={onReload}>
        再読み込み
      </button>
    </div>
  );
}

const FORGE_LABELS: Record<ForgeKind, string> = { github: 'GitHub' };

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
