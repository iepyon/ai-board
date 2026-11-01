import { useMemo } from 'react';
import { parseReasonBlocks } from '../../../shared/markdown.js';
import { REVIEW_GATE_LABELS, reviewTone } from '../../../shared/review-labels.js';
import { formatDateTime } from '../../format.js';
import { MarkdownBlocks } from './BodyView.js';
import type { BoardCardReview } from '../../types.js';

// ============================================================
// 判断の記録
// ============================================================

/**
 * カードの判断（`reviews`）を、本文とは別の欄に書かれた順で出す。
 *
 * 判断の見出し（時刻・ゲート・種別）は値から描く部品で、理由の文字からは作らない。
 * 理由は Markdown として整形するが、見出しの行は `parseReasonBlocks` が記号付きの普通の行に戻すので、
 * 理由に何を書いても見出しにも別の判断にも見えない。判断が無ければ欄ごと出さない。
 */
export function ReviewLog({ reviews }: { reviews: readonly BoardCardReview[] }) {
  if (reviews.length === 0) return null;

  return (
    <>
      <h3>判断の記録</h3>
      <ol className="review-log">
        {reviews.map((review, index) => (
          <ReviewItem key={`${review.at}-${index}`} review={review} />
        ))}
      </ol>
    </>
  );
}

function ReviewItem({ review }: { review: BoardCardReview }) {
  const blocks = useMemo(() => parseReasonBlocks(review.reason), [review.reason]);

  return (
    <li className={`review-entry tone-${reviewTone(review.kind)}`}>
      <div className="review-entry-head">
        <span className="review-entry-kind">{`${REVIEW_GATE_LABELS[review.gate]} ${review.kind}`}</span>
        <time className="review-entry-at" dateTime={review.at}>
          {formatDateTime(review.at)}
        </time>
      </div>
      {blocks.length === 0 ? (
        <p className="review-entry-empty">（理由なし）</p>
      ) : (
        <MarkdownBlocks blocks={blocks} className="review-entry-reason" />
      )}
    </li>
  );
}
