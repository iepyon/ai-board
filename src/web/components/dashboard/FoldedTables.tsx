import type { ReactNode } from 'react';
import { mergedAt } from '../../../shared/dashboard-sections.js';
import { formatDay, formatDateTime } from '../../format.js';
import { CardTitle, Progress, StagePill } from './parts.js';
import { sectionAnchor } from './PipelineStrip.js';
import type { BoardCard } from '../../types.js';

// ============================================================
// マージ済み / 中止 — 既定では折りたたむ表
// ============================================================

interface FoldProps {
  id: string;
  title: string;
  summary: string;
  children: ReactNode;
}

/** 見出しを押すと開く区画。見返すための場所なので、既定では閉じておく */
function Fold({ id, title, summary, children }: FoldProps) {
  return (
    <section className="sec" id={id}>
      <details className="fold">
        <summary className="sec-h">
          <h2>{title}</h2>
          <span className="count">{summary}</span>
        </summary>
        {children}
      </details>
    </section>
  );
}

interface TableProps {
  cards: readonly BoardCard[];
  onSelect: (card: BoardCard) => void;
}

/** マージの新しい順 */
export function MergedTable({ cards, onSelect }: TableProps) {
  return (
    <Fold id={sectionAnchor('merged')} title="マージ済み" summary={`${cards.length} 件`}>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>カード</th>
              <th>PR</th>
              <th>タスク</th>
              <th>マージ</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((card) => (
              <tr key={card.id}>
                <td>
                  <CardTitle card={card} onSelect={onSelect} />
                  <div className="sub">{card.id}</div>
                </td>
                <td>
                  <PrLink card={card} />
                </td>
                <td>
                  <Tasks card={card} />
                </td>
                <td className="d">
                  <Day iso={mergedAt(card)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Fold>
  );
}

/** 中止されたカード。どのステージで止めたかを残す */
export function AbortedTable({ cards, onSelect }: TableProps) {
  if (cards.length === 0) return null;

  return (
    <Fold id={sectionAnchor('aborted')} title="中止" summary={`${cards.length} 件`}>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>カード</th>
              <th>止めたステージ</th>
              <th>起票</th>
            </tr>
          </thead>
          <tbody>
            {cards.map((card) => (
              <tr key={card.id} className="aborted">
                <td>
                  <CardTitle card={card} onSelect={onSelect} />
                  <div className="sub">{card.id}</div>
                </td>
                <td>
                  <StagePill stage={card.stage} />
                </td>
                <td className="d">
                  <Day iso={card.created} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Fold>
  );
}

function PrLink({ card }: { card: BoardCard }) {
  if (card.mrState === null) return <span className="sub">—</span>;

  return (
    <a href={card.mrState.webUrl} target="_blank" rel="noreferrer" className="pr-link">
      #{card.mrState.iid}
    </a>
  );
}

function Tasks({ card }: { card: BoardCard }) {
  const tasks = card.plan?.tasks;
  if (tasks === undefined || tasks.total === 0) return <span className="sub">—</span>;

  return (
    <div className="mini num">
      <Progress completed={tasks.completed} total={tasks.total} />
      {tasks.completed}/{tasks.total}
    </div>
  );
}

function Day({ iso }: { iso: string | null }) {
  if (iso === null) return <>—</>;

  return <span title={formatDateTime(iso)}>{formatDay(iso)}</span>;
}
