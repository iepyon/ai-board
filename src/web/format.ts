// ============================================================
// 日時の表記
// ============================================================

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** 「12 分前」「5 時間前」「3 日前」。解釈できない値はそのまま返す */
export function formatAgo(iso: string, now: Date = new Date()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;

  const elapsed = Math.max(0, now.getTime() - at);

  if (elapsed < MINUTE_MS) return 'たった今';
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)} 分前`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} 時間前`;

  return `${Math.floor(elapsed / DAY_MS)} 日前`;
}

/** 表の日付欄に出す「09-25」 */
export function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${month}-${day}`;
}

/** 詳細な時刻。title 属性に出す */
export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('ja-JP');
}
