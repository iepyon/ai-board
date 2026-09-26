import { Fragment, useState, type DragEvent } from 'react';
import { moveTargetFor, type MoveTarget } from '../../../shared/card-reorder.js';
import type { IdeaRow } from '../../../shared/dashboard-sections.js';
import { formatDay, formatDateTime } from '../../format.js';
import { CardTitle, SectionHead } from './parts.js';
import { sectionAnchor } from './PipelineStrip.js';
import type { BoardCard } from '../../types.js';

// ============================================================
// アイデア — 表形式。行のドラッグで並べ替える
// 区切り線より上が「次にやる」、下が「あとで考える」
// ============================================================

/** 表の列数。区切り線や空の行はこれを跨ぐ */
const COLUMNS = 5;

interface IdeaTableProps {
  /** 「次にやる」のカード、区切り線、「あとで考える」のカードの順に並んだ行 */
  rows: readonly IdeaRow<BoardCard>[];
  onSelect: (card: BoardCard) => void;
  onStart: (card: BoardCard) => void;
  /** 並べ替え。動かした行（カード ID か区切り線）と、隣の行を渡す */
  onReorder: (id: string, target: MoveTarget) => void;
}

export function IdeaTable({ rows, onSelect, onStart, onReorder }: IdeaTableProps) {
  const [query, setQuery] = useState('');
  /** ドラッグ中の行の ID（カード ID か区切り線） */
  const [dragging, setDragging] = useState<string | null>(null);
  /** 挿入位置（動かす前の並びでの添字） */
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const cards = rows.flatMap((row) => (row.kind === 'card' ? [row.card] : []));
  const needle = query.trim().toLowerCase();
  // 絞り込み中は区切り線を出さず、並べ替えも受けない。見えていないカードとの位置関係が分からない
  const reorderable = needle === '';
  const visible = reorderable
    ? rows
    : rows.filter((row) => row.kind === 'card' && matches(row.card, needle));
  const nextCount = rows.findIndex((row) => row.kind === 'divider');

  const target =
    dragging !== null && dropIndex !== null
      ? moveTargetFor(
          rows.map((row) => row.id),
          dragging,
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
        hint="上にあるものほど優先。行や区切り線をドラッグして並べ替える"
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
            {reorderable && cards.length > 0 && <TierHead label="次にやる" count={nextCount} />}
            {visible.map((row, index) => (
              <Fragment key={row.id}>
                {lineAt === index && <DropLine />}
                {row.kind === 'card' ? (
                  <IdeaCardRow
                    card={row.card}
                    draggable={reorderable}
                    dragging={dragging === row.id}
                    onSelect={onSelect}
                    onStart={onStart}
                    onDragStart={() => setDragging(row.id)}
                    onDragEnd={reset}
                  />
                ) : (
                  cards.length > 0 && (
                    <DividerRow
                      count={cards.length - nextCount}
                      dragging={dragging === row.id}
                      onDragStart={() => setDragging(row.id)}
                      onDragEnd={reset}
                    />
                  )
                )}
              </Fragment>
            ))}
            {lineAt === visible.length && <DropLine />}
            {cards.length === 0 || (!reorderable && visible.length === 0) ? (
              <tr>
                <td colSpan={COLUMNS} className="empty-row">
                  {cards.length === 0 ? 'アイデアはありません。' : '一致するアイデアはありません。'}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

interface IdeaCardRowProps {
  card: BoardCard;
  draggable: boolean;
  dragging: boolean;
  onSelect: (card: BoardCard) => void;
  onStart: (card: BoardCard) => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

function IdeaCardRow({
  card,
  draggable,
  dragging,
  onSelect,
  onStart,
  onDragStart,
  onDragEnd,
}: IdeaCardRowProps) {
  const handleDragStart = (event: DragEvent<HTMLTableRowElement>): void => {
    startDrag(event, card.id);
    onDragStart();
  };

  return (
    <tr
      data-row-id={card.id}
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

function TierHead({ label, count }: { label: string; count: number }) {
  return (
    <tr className="tier-head">
      <td colSpan={COLUMNS}>
        {label}
        <span className="tier-count">{count}</span>
      </td>
    </tr>
  );
}

interface DividerRowProps {
  /** 区切り線より下のアイデアの数 */
  count: number;
  dragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}

/** 区切り線。カードの行と同じくドラッグで動かせ、下の見出しを兼ねる */
function DividerRow({ count, dragging, onDragStart, onDragEnd }: DividerRowProps) {
  const handleDragStart = (event: DragEvent<HTMLTableRowElement>): void => {
    startDrag(event, 'divider');
    onDragStart();
  };

  return (
    <tr
      data-row-id="divider"
      draggable
      className={dragging ? 'tier-divider dragging' : 'tier-divider'}
      title="ドラッグして区切り線を動かす"
      onDragStart={handleDragStart}
      onDragEnd={onDragEnd}
    >
      <td className="grip" aria-hidden="true">
        ⋮⋮
      </td>
      <td colSpan={COLUMNS - 1}>
        あとで考える
        <span className="tier-count">{count}</span>
      </td>
    </tr>
  );
}

function DropLine() {
  return (
    <tr className="drop-line" aria-hidden="true">
      <td colSpan={COLUMNS} />
    </tr>
  );
}

function startDrag(event: DragEvent<HTMLTableRowElement>, id: string): void {
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', id);
}

function matches(card: BoardCard, needle: string): boolean {
  return [card.title, card.id, card.branch ?? ''].some((text) =>
    text.toLowerCase().includes(needle)
  );
}

/** ポインタの Y より上に中心がある行（カードと区切り線）の数＝挿入位置 */
function dropIndexAt(tbody: HTMLElement, clientY: number): number {
  const rows = tbody.querySelectorAll<HTMLElement>('tr[data-row-id]');
  let index = 0;

  rows.forEach((row) => {
    const rect = row.getBoundingClientRect();
    if (rect.top + rect.height / 2 < clientY) index += 1;
  });

  return index;
}
