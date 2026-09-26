import { Fragment, useState, type DragEvent } from 'react';
import { moveTargetFor, type MoveTarget } from '../../../shared/card-reorder.js';
import { formatDay, formatDateTime } from '../../format.js';
import { CardTitle, SectionHead } from './parts.js';
import { sectionAnchor } from './PipelineStrip.js';
import type { BoardCard } from '../../types.js';

// ============================================================
// アイデア — 表形式。行のドラッグで並べ替える
// ============================================================

interface IdeaTableProps {
  /** `rank` の順に並んだアイデアのカード */
  cards: readonly BoardCard[];
  onSelect: (card: BoardCard) => void;
  onStart: (card: BoardCard) => void;
  /** 並べ替え。隣のカードを渡す */
  onReorder: (card: BoardCard, target: MoveTarget) => void;
}

export function IdeaTable({ cards, onSelect, onStart, onReorder }: IdeaTableProps) {
  const [query, setQuery] = useState('');
  const [dragging, setDragging] = useState<BoardCard | null>(null);
  /** 挿入位置（動かす前の並びでの添字） */
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const needle = query.trim().toLowerCase();
  const visible = needle === '' ? cards : cards.filter((card) => matches(card, needle));
  // 絞り込み中の並べ替えは、見えていないカードとの位置関係が分からないので受けない
  const reorderable = needle === '';

  const target =
    dragging !== null && dropIndex !== null
      ? moveTargetFor(
          cards.map((card) => card.id),
          dragging.id,
          dropIndex
        )
      : null;
  const lineAt = target !== null ? dropIndex : null;

  const reset = (): void => {
    setDragging(null);
    setDropIndex(null);
  };

  const handleDragOver = (event: DragEvent<HTMLTableSectionElement>): void => {
    if (dragging === null) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropIndex(dropIndexAt(event.currentTarget, event.clientY));
  };

  const handleDrop = (event: DragEvent<HTMLTableSectionElement>): void => {
    event.preventDefault();
    if (dragging !== null && target !== null) onReorder(dragging, target);
    reset();
  };

  return (
    <section className="sec" id={sectionAnchor('idea')}>
      <SectionHead
        title="アイデア"
        count={cards.length}
        hint="上にあるものほど優先。行をドラッグして並べ替える"
      />

      <div className="toolbar">
        <input
          id="idea-search"
          className="search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="タイトル・ID・ブランチで絞り込み"
          aria-label="アイデアを絞り込む"
        />
      </div>

      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th aria-label="並べ替え" />
              <th>カード</th>
              <th>ブランチ</th>
              <th>起票</th>
              <th aria-label="操作" />
            </tr>
          </thead>
          <tbody onDragOver={handleDragOver} onDrop={handleDrop}>
            {visible.map((card, index) => (
              <Fragment key={card.id}>
                {lineAt === index && <DropLine />}
                <IdeaRow
                  card={card}
                  draggable={reorderable}
                  dragging={dragging?.id === card.id}
                  onSelect={onSelect}
                  onStart={onStart}
                  onDragStart={() => setDragging(card)}
                  onDragEnd={reset}
                />
              </Fragment>
            ))}
            {lineAt === visible.length && <DropLine />}
            {visible.length === 0 && (
              <tr>
                <td colSpan={5} className="empty-row">
                  {cards.length === 0 ? 'アイデアはありません。' : '一致するアイデアはありません。'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface IdeaRowProps {
  card: BoardCard;
  draggable: boolean;
  dragging: boolean;
  onSelect: (card: BoardCard) => void;
  onStart: (card: BoardCard) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

function IdeaRow({
  card,
  draggable,
  dragging,
  onSelect,
  onStart,
  onDragStart,
  onDragEnd,
}: IdeaRowProps) {
  const handleDragStart = (event: DragEvent<HTMLTableRowElement>): void => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', card.id);
    onDragStart();
  };

  return (
    <tr
      data-card-id={card.id}
      draggable={draggable}
      className={dragging ? 'dragging' : undefined}
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
    >
      <td className="grip" aria-hidden="true">
        {draggable ? '⋮⋮' : ''}
      </td>
      <td>
        <CardTitle card={card} onSelect={onSelect} />
        <div className="sub">{card.id}</div>
      </td>
      <td className="sub">{card.branch ?? '—'}</td>
      <td className="d" title={formatDateTime(card.created)}>
        {formatDay(card.created)}
      </td>
      <td className="r">
        {card.droppableStages.includes('planning') && (
          <button type="button" className="btn sm" onClick={() => onStart(card)}>
            着手
          </button>
        )}
      </td>
    </tr>
  );
}

function DropLine() {
  return (
    <tr className="drop-line" aria-hidden="true">
      <td colSpan={5} />
    </tr>
  );
}

function matches(card: BoardCard, needle: string): boolean {
  return [card.title, card.id, card.branch ?? ''].some((text) =>
    text.toLowerCase().includes(needle)
  );
}

/** ポインタの Y より上に中心がある行の枚数＝挿入位置 */
function dropIndexAt(tbody: HTMLElement, clientY: number): number {
  const rows = tbody.querySelectorAll<HTMLElement>('tr[data-card-id]');
  let index = 0;

  rows.forEach((row) => {
    const rect = row.getBoundingClientRect();
    if (rect.top + rect.height / 2 < clientY) index += 1;
  });

  return index;
}
