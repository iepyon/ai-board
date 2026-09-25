import type { BoardCard } from '../../types.js';
import type { CardMetaPatch } from '../../api.js';

// ============================================================
// branch / MR の紐付け
// ============================================================

interface LinkFieldsProps {
  card: BoardCard;
  saving: boolean;
  onPatch: (patch: CardMetaPatch) => void;
}

/**
 * カードは不変の id を軸に branch / mr を後から獲得していく。
 * ここがその紐付けを編集する唯一の場所。計画ファイルは id で決まるので現れない。
 */
export function LinkFields({ card, saving, onPatch }: LinkFieldsProps) {
  /** 空文字は「紐付けを外す」として null に変換する */
  const commitText = (key: 'branch', raw: string): void => {
    const value = raw.trim();
    if (value === (card[key] ?? '')) return;
    onPatch({ [key]: value === '' ? null : value } as CardMetaPatch);
  };

  return (
    <>
      <h3>紐付け</h3>

      <div className="field">
        <label htmlFor="field-branch">branch</label>
        <input
          id="field-branch"
          defaultValue={card.branch ?? ''}
          placeholder="feat/..."
          disabled={saving}
          onBlur={(event) => commitText('branch', event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="field-mr">MR iid</label>
        <input
          id="field-mr"
          type="number"
          min={1}
          defaultValue={card.mr ?? ''}
          placeholder="branch から自動解決されます"
          disabled={saving}
          onBlur={(event) => {
            const raw = event.target.value.trim();
            const next = raw === '' ? null : Number(raw);
            if (next !== card.mr) onPatch({ mr: next });
          }}
        />
      </div>

      {card.mrState !== null && (
        <p className="mr-link">
          <a href={card.mrState.webUrl} target="_blank" rel="noreferrer">
            !{card.mrState.iid} {card.mrState.title}
          </a>
          <br />
          レビューコメント {card.mrState.noteCount} 件
          {card.mrState.latestCommitAt !== null &&
            ` / 最新コミット ${formatDateTime(card.mrState.latestCommitAt)}`}
        </p>
      )}
    </>
  );
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('ja-JP');
}
