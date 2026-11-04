// ============================================================
// PR のチェック（CI の結果）のまとめと判定
// ============================================================

/**
 * GitHub のチェックには 2 系統がある。
 *
 * - Checks API（`commits/{sha}/check-runs`）: GitHub Actions など
 * - Commit Status API（`commits/{sha}/status`）: 外部の CI など。コンテキストごとの最新だけが返る
 *
 * 片方だけ見ると落ちたチェックを見落とすので、両方を 1 つの表にまとめる。
 * 同じ名前が両方にあっても突き合わせない（名前の付け方は CI ごとに違い、取り違えるため）。
 * `gh` の出力から切り離した純関数にして、判定をテストで守る。
 */

/** 1 本のチェックの結果 */
export type CheckOutcome = 'passed' | 'failed' | 'pending';

/** 全体の判定。`none` はチェックが 1 つも無い */
export type ChecksVerdict = 'passed' | 'failed' | 'pending' | 'none';

export interface CheckRow {
  readonly name: string;
  readonly source: 'check-run' | 'status';
  readonly outcome: CheckOutcome;
  /** GitHub が返した生の値（`conclusion` / `state`）。人が読むために出す */
  readonly detail: string;
  readonly url: string | null;
}

export interface ChecksSummary {
  readonly sha: string;
  readonly verdict: ChecksVerdict;
  readonly rows: readonly CheckRow[];
}

/** `check-runs` の 1 件のうち、使う項目 */
export interface RawCheckRun {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url?: string | null;
  readonly details_url?: string | null;
}

/** `status` の `statuses` の 1 件のうち、使う項目 */
export interface RawCommitStatus {
  readonly context: string;
  readonly state: string;
  readonly target_url?: string | null;
}

const PASSED_CONCLUSIONS = new Set(['success', 'neutral', 'skipped']);

/**
 * `check-runs` の 1 件の結果。
 *
 * `status` が `completed` でなければ走っている。終わっていれば `conclusion` で決め、
 * 成功・中立・飛ばした以外（`failure` / `cancelled` / `timed_out` / `action_required` / `stale` と、知らない値）は落ちたとみなす。
 * 知らない値を通すと、落ちたものを通ったと書いてしまうため。
 */
export function checkRunOutcome(run: RawCheckRun): CheckOutcome {
  if (run.status !== 'completed') return 'pending';
  return run.conclusion !== null && PASSED_CONCLUSIONS.has(run.conclusion) ? 'passed' : 'failed';
}

/** `status` の 1 件の結果。`pending` は走っている、`success` だけが通った。ほか（`failure` / `error`）は落ちた */
export function commitStatusOutcome(status: RawCommitStatus): CheckOutcome {
  if (status.state === 'pending') return 'pending';
  return status.state === 'success' ? 'passed' : 'failed';
}

/** 行から全体の判定を出す。落ちたものが 1 つでもあれば `failed`、無くて走っているものがあれば `pending` */
export function checksVerdict(rows: readonly CheckRow[]): ChecksVerdict {
  if (rows.length === 0) return 'none';
  if (rows.some((row) => row.outcome === 'failed')) return 'failed';
  if (rows.some((row) => row.outcome === 'pending')) return 'pending';
  return 'passed';
}

/** 2 系統の生の値を 1 つの表にまとめる。`check-runs` を先に、名前の順に並べる */
export function summarizeChecks(
  sha: string,
  checkRuns: readonly RawCheckRun[],
  statuses: readonly RawCommitStatus[]
): ChecksSummary {
  const byName = (a: CheckRow, b: CheckRow): number => a.name.localeCompare(b.name);

  const runRows = checkRuns
    .map((run): CheckRow => ({
      name: run.name,
      source: 'check-run',
      outcome: checkRunOutcome(run),
      detail: run.status === 'completed' ? (run.conclusion ?? 'unknown') : run.status,
      url: run.html_url ?? run.details_url ?? null,
    }))
    .sort(byName);

  const statusRows = statuses
    .map((status): CheckRow => ({
      name: status.context,
      source: 'status',
      outcome: commitStatusOutcome(status),
      detail: status.state,
      url: status.target_url ?? null,
    }))
    .sort(byName);

  const rows = [...runRows, ...statusRows];
  return { sha, verdict: checksVerdict(rows), rows };
}
