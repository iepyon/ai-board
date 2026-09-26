import { isStale, STALE_DAYS } from '../../../shared/dashboard-sections.js';
import { formatAgo, formatDateTime } from '../../format.js';
import { CardTitle, Progress, SectionHead, StagePill } from './parts.js';
import { sectionAnchor } from './PipelineStrip.js';
import type { BoardCard } from '../../types.js';

// ============================================================
// AI が進めている
// ============================================================

interface WorkSectionProps {
  cards: readonly BoardCard[];
  onSelect: (card: BoardCard) => void;
  /** 着手を取り消す（アイデアへ戻す）。計画提案中のカードにだけ出す */
  onUnstart: (card: BoardCard) => void;
}

export function WorkSection({ cards, onSelect, onUnstart }: WorkSectionProps) {
  const now = new Date();

  return (
    <section className="sec" id={sectionAnchor('work')}>
      <SectionHead
        title="AI が進めている"
        count={cards.length}
        hint="着手を戻せるのは計画提案中だけ"
      />

      {cards.length === 0 ? (
        <p className="empty-box">AI が進めているカードはありません。</p>
      ) : (
        <div className="work">
          {cards.map((card) => (
            <WorkItem
              key={card.id}
              card={card}
              now={now}
              onSelect={onSelect}
              onUnstart={onUnstart}
            />
          ))}
        </div>
      )}
    </section>
  );
}

interface WorkItemProps {
  card: BoardCard;
  now: Date;
  onSelect: (card: BoardCard) => void;
  onUnstart: (card: BoardCard) => void;
}

function WorkItem({ card, now, onSelect, onUnstart }: WorkItemProps) {
  const tasks = card.plan?.tasks;

  return (
    <div className="work-item">
      <div className="meta">
        <StagePill stage={card.stage} />
        <span className="tag">{card.id}</span>
      </div>

      <h3>
        <CardTitle card={card} onSelect={onSelect} />
      </h3>

      {tasks !== undefined && tasks.total > 0 && (
        <Progress completed={tasks.completed} total={tasks.total} />
      )}

      <div className="meta num">
        {tasks !== undefined && tasks.total > 0 && (
          <span>
            {tasks.completed} / {tasks.total}
          </span>
        )}
        <Activity card={card} now={now} />
      </div>

      {card.droppableStages.includes('idea') && (
        <div>
          <button type="button" className="btn ghost sm" onClick={() => onUnstart(card)}>
            着手を戻す
          </button>
        </div>
      )}
    </div>
  );
}

/** 最後に動いた時刻。しばらく動いていなければ目立たせる */
function Activity({ card, now }: { card: BoardCard; now: Date }) {
  const since = card.plan?.updatedAt ?? card.startedAt;
  if (since === null) return <span>計画ファイルはまだ無い</span>;

  const label =
    card.plan === null ? `着手 ${formatAgo(since, now)}` : `更新 ${formatAgo(since, now)}`;

  if (isStale(card, now)) {
    return (
      <span
        className="stale"
        title={`${STALE_DAYS} 日以上動きがありません（${formatDateTime(since)}）`}
      >
        {label} · 動きなし
      </span>
    );
  }

  return <span title={formatDateTime(since)}>{label}</span>;
}
