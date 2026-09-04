import type { MergeRequestIid } from '../../shared/schemas/common.js';
import type { GitLabConfig } from '../../shared/config.js';
import type { MrLifecycleState, MrState } from '../models/mr-state.js';
import { MR_STATES } from '../models/mr-state.js';

// ============================================================
// GitLab REST API v4 クライアント
// ============================================================

/**
 * カード単位で問い合わせる。
 * MR 一覧の全件取得はページングで取りこぼすため使わない。
 */
export interface GitLabClient {
  /** iid が既知の MR を取得する */
  fetchByIid(iid: MergeRequestIid): Promise<MrState | null>;
  /** source branch から MR を解決する。複数ある場合は最新の 1 件 */
  fetchByBranch(branch: string): Promise<MrState | null>;
}

interface RawMergeRequest {
  iid: number;
  state: string;
  source_branch: string;
  title: string;
  web_url: string;
  updated_at?: string;
}

interface RawNote {
  system: boolean;
  created_at: string;
}

interface RawCommit {
  committed_date: string;
}

export class HttpGitLabClient implements GitLabClient {
  private readonly projectPath: string;

  constructor(
    private readonly config: GitLabConfig,
    private readonly fetchFn: typeof fetch = fetch
  ) {
    this.projectPath = encodeURIComponent(String(config.projectId));
  }

  async fetchByIid(iid: MergeRequestIid): Promise<MrState | null> {
    const mr = await this.get<RawMergeRequest>(`/merge_requests/${iid}`);
    return mr === null ? null : this.enrich(mr);
  }

  async fetchByBranch(branch: string): Promise<MrState | null> {
    const query = `source_branch=${encodeURIComponent(branch)}&state=all&order_by=updated_at&per_page=1`;
    const list = await this.get<RawMergeRequest[]>(`/merge_requests?${query}`);

    const mr = list?.[0];
    return mr === undefined ? null : this.enrich(mr);
  }

  /**
   * MR 本体に加えてノートと最新コミットを取得する。
   * ai-pr-fixed の判定にはこの 2 つの日時比較が必要。
   */
  private async enrich(mr: RawMergeRequest): Promise<MrState> {
    const [notes, commits] = await Promise.all([
      this.get<RawNote[]>(`/merge_requests/${mr.iid}/notes?sort=desc&per_page=20`),
      this.get<RawCommit[]>(`/merge_requests/${mr.iid}/commits?per_page=1`),
    ]);

    // system note（「ブランチを push しました」等の自動生成）はレビューコメントではない
    const humanNotes = asArray(notes).filter((note) => !note.system);

    return {
      iid: mr.iid as MergeRequestIid,
      state: toLifecycleState(mr.state),
      sourceBranch: mr.source_branch,
      title: mr.title,
      webUrl: mr.web_url,
      latestNoteAt: latestOf(humanNotes.map((note) => note.created_at)),
      noteCount: humanNotes.length,
      latestCommitAt: latestOf(asArray(commits).map((commit) => commit.committed_date)),
    };
  }

  /** 404 は「存在しない」として null を返す。それ以外の失敗は例外にする */
  private async get<T>(endpoint: string): Promise<T | null> {
    const url = `${this.config.url}/api/v4/projects/${this.projectPath}${endpoint}`;

    const response = await this.fetchFn(url, {
      headers: { 'PRIVATE-TOKEN': this.config.token },
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`GitLab API がエラーを返しました: ${response.status} ${endpoint}`);
    }

    return (await response.json()) as T;
  }
}

// ============================================================
// ヘルパー
// ============================================================

/** 想定外のレスポンス形（プロキシの HTML など）でクラッシュさせない */
function asArray<T>(value: T[] | null): T[] {
  return Array.isArray(value) ? value : [];
}

function toLifecycleState(raw: string): MrLifecycleState {
  return (MR_STATES as readonly string[]).includes(raw) ? (raw as MrLifecycleState) : 'closed';
}

/** ISO 8601 文字列の配列から最も新しいものを返す */
function latestOf(timestamps: readonly string[]): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;

  for (const timestamp of timestamps) {
    const ms = Date.parse(timestamp);
    if (Number.isNaN(ms)) continue;
    if (ms > latestMs) {
      latestMs = ms;
      latest = timestamp;
    }
  }

  return latest;
}
