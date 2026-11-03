import { useState } from 'react';
import { ReviewActions } from '../detail/ReviewActions.js';
import { HoldNote } from '../detail/HoldNote.js';
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
              <GateReviewItem key={card.id} card={card} onSelect={onSelect} onChanged={onChanged} />
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

interface GateReviewItemProps {
  card: BoardCard;
  onSelect: (card: BoardCard) => void;
  onChanged: () => void;
}

/**
 * 計画レビューのカード、と AI の列で止まっているカード。
 * 提出に書かれた本文（判断待ちの点）や保留の理由と PR へのリンクを見せ、
 * 「判断する」でその場にレビュー欄を開く。計画の本文や差分は PR で読む。
 */
function GateReviewItem({ card, onSelect, onChanged }: GateReviewItemProps) {
  const [open, setOpen] = useState(false);
  const { saving, error, run } = useAction(onChanged);
  const tasks = card.plan?.tasks;
  const mr = card.mrState;
  const panelId = `review-${card.id}`;

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
            {mr?.draft === true && <span>Draft</span>}
          </div>
          <h3>
            <CardTitle card={card} onSelect={onSelect} />
          </h3>
        </div>

        <div className="acts">
          <ReviewPrLink card={card} />
          <button
            type="button"
            className={open ? 'btn ghost' : 'btn'}
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((on) => !on)}
          >
            {open ? '閉じる' : '判断する'}
          </button>
        </div>

        <HoldNote card={card} />
        <SubmissionNote card={card} />
      </div>

      {open && (
        <div className="plan-view" id={panelId}>
          <div className="review-pane">
            {error !== null && <div className="divergence">{error}</div>}
            <ReviewActions card={card} saving={saving} onRun={run} />
          </div>
        </div>
      )}
    </article>
  );
}

/**
 * 判断の材料を読む PR へのリンク。計画レビューと計画提案中の止まりでは計画を読み、
 * 実装中の止まり（Draft に戻された PR）では PR を開く。
 */
function ReviewPrLink({ card }: { card: BoardCard }) {
  const mr = card.mrState;
  const readsPlan = card.stage === 'plan-review' || card.stage === 'planning';

  if (mr === null) {
    return (
      <span className="movable">
        {readsPlan ? '計画の PR がまだありません' : 'PR がまだありません'}
      </span>
    );
  }

  return (
    <a className="btn ghost" href={mr.webUrl} target="_blank" rel="noreferrer">
      {readsPlan ? `計画の PR #${mr.iid} を読む ↗` : `PR #${mr.iid} を開く ↗`}
    </a>
  );
}

/**
 * 提出（再提出）に AI が書いた本文。判断の材料なので畳まずに出す。
 * `latestReview` はその列が待つゲートの最新エントリなので、札にゲートの名前を出す。
 * 止まっているカード（AI の列）ではゲートを問わず最新のエントリで、AI の保留ならその理由が出る。
 */
function SubmissionNote({ card }: { card: BoardCard }) {
  const review = card.latestReview;

  if (review === null) {
    // 止まっているカードは止まりの札（HoldNote）が状況を書いている。計画の提出漏れの文言を重ねない
    if (card.hold !== null) return null;
    const artifact = card.mrState?.draft === true ? '計画の PR' : '計画ファイル';
    return <div className="why">提出の記録がありません。{artifact}だけがあります。</div>;
  }

  return (
    <div className="why">
      <span className="why-kind">
        {review.gate} {review.kind}
      </span>
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
