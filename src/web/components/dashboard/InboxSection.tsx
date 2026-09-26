import { useState } from 'react';
import { PlanSection } from '../detail/PlanSection.js';
import { ReviewActions } from '../detail/ReviewActions.js';
import { useAction } from '../../hooks/useAction.js';
import { waitingSince } from '../../../shared/dashboard-sections.js';
import { formatAgo, formatDateTime } from '../../format.js';
import { CardTitle, SectionHead, StagePill } from './parts.js';
import { sectionAnchor } from './PipelineStrip.js';
import type { BoardCard } from '../../types.js';

// ============================================================
// あなたの判断を待っている
// ============================================================

interface InboxSectionProps {
  /** 待ち始めた時刻の古い順に並んだ判断待ちのカード */
  cards: readonly BoardCard[];
  onSelect: (card: BoardCard) => void;
  onChanged: () => void;
}

export function InboxSection({ cards, onSelect, onChanged }: InboxSectionProps) {
  return (
    <section className="sec" id={sectionAnchor('inbox')}>
      <SectionHead title="あなたの判断を待っている" count={cards.length} hint="待ち時間の長い順" />

      {cards.length === 0 ? (
        <p className="empty-box">判断を待っているカードはありません。</p>
      ) : (
        <div className="inbox">
          {cards.map((card) =>
            card.stage === 'pr' ? (
              <PrItem key={card.id} card={card} onSelect={onSelect} />
            ) : (
              <PlanReviewItem key={card.id} card={card} onSelect={onSelect} onChanged={onChanged} />
            )
          )}
        </div>
      )}
    </section>
  );
}

/** 待ち時間。取れなければ出さない */
function Waiting({ card }: { card: BoardCard }) {
  const since = waitingSince(card);
  if (since === null) return null;

  return <span title={formatDateTime(since)}>{formatAgo(since)}から待ち</span>;
}

interface PlanReviewItemProps {
  card: BoardCard;
  onSelect: (card: BoardCard) => void;
  onChanged: () => void;
}

/**
 * 計画レビューのカード。提出に書かれた判断待ちの点を見せ、
 * 「計画を読む」でその場に計画の本文とレビュー欄を開く。
 */
function PlanReviewItem({ card, onSelect, onChanged }: PlanReviewItemProps) {
  const [open, setOpen] = useState(false);
  const { saving, error, run } = useAction(onChanged);
  const tasks = card.plan?.tasks;
  const panelId = `plan-${card.id}`;

  return (
    <article className="item">
      <div className="item-main">
        <div>
          <div className="meta">
            <StagePill stage={card.stage} />
            <span className="tag">{card.id}</span>
            <Waiting card={card} />
            {tasks !== undefined && tasks.total > 0 && (
              <span className="num">タスク {tasks.total}</span>
            )}
          </div>
          <h3>
            <CardTitle card={card} onSelect={onSelect} />
          </h3>
        </div>

        <div className="acts">
          <button
            type="button"
            className={open ? 'btn ghost' : 'btn'}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((on) => !on)}
          >
            {open ? '計画を閉じる' : '計画を読んで判断する'}
          </button>
        </div>

        <SubmissionNote card={card} />
      </div>

      {open && (
        <div className="plan-view" id={panelId}>
          <div>
            <PlanSection card={card} />
          </div>
          <div className="review-pane">
            {error !== null && <div className="divergence">{error}</div>}
            <ReviewActions card={card} saving={saving} onRun={run} />
          </div>
        </div>
      )}
    </article>
  );
}

/** 提出（再提出）に AI が書いた本文。判断の材料なので畳まずに出す */
function SubmissionNote({ card }: { card: BoardCard }) {
  const review = card.latestReview;

  if (review === null) {
    return <div className="why">提出の記録がありません。計画ファイルだけが置かれています。</div>;
  }

  return (
    <div className="why">
      <span className="why-kind">plan {review.kind}</span>
      {review.reason === '' ? '（本文なし）' : review.reason}
    </div>
  );
}

/** PR中 のカード。判断は GitHub で行うので、状況と PR へのリンクだけを出す */
function PrItem({ card, onSelect }: { card: BoardCard; onSelect: (card: BoardCard) => void }) {
  const mr = card.mrState;

  return (
    <article className="item pr">
      <div className="item-main">
        <div>
          <div className="meta">
            <StagePill stage={card.stage} />
            <span className="tag">{card.id}</span>
            <Waiting card={card} />
            {mr !== null && <span>コメント {mr.noteCount}</span>}
          </div>
          <h3>
            <CardTitle card={card} onSelect={onSelect} />
          </h3>
        </div>

        <div className="acts">
          {mr !== null && (
            <a className="btn" href={mr.webUrl} target="_blank" rel="noreferrer">
              PR #{mr.iid} を開く ↗
            </a>
          )}
        </div>

        <div className="why">{describePr(card)}</div>
      </div>
    </article>
  );
}

function describePr(card: BoardCard): string {
  const mr = card.mrState;
  if (mr === null) return 'PR の状態を取得できていません。';

  if (mr.resubmitted) {
    const at = mr.latestCommitAt === null ? '' : `（${formatAgo(mr.latestCommitAt)}）`;
    return `再レビュー待ち。指摘のあとに修正コミットが push されました${at}。`;
  }

  return mr.noteCount === 0
    ? 'まだレビューされていません。'
    : 'レビューの指摘に対する修正を待っています。';
}
