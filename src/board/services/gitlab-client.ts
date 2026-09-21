import type { MergeRequestIid } from '../../shared/schemas/common.js';
import type { ForgeConfig } from '../../shared/config.js';
import type { ForgeKind, MrLifecycleState, MrState } from '../models/mr-state.js';
import { MR_STATES } from '../models/mr-state.js';
import { asArray, latestOf, toMergeRequestIid, type ForgeClient } from './forge-client.js';
import {
  parseJson,
  describeCliError,
  unwrap,
  type CliRunner,
} from '../../infrastructure/cli-runner.js';

// ============================================================
// GitLab — glab CLI 経由
// ============================================================

export const GLAB = 'glab';

interface RawMergeRequest {
  iid: number;
  state: string;
  source_branch: string;
  title: string;
  web_url: string;
}

interface RawNote {
  system: boolean;
  created_at: string;
}

interface RawCommit {
  committed_date: string;
}

type GitLabForge = Extract<ForgeConfig, { kind: 'gitlab' }>;

/**
 * `glab api` を実行して Merge Request を取得する。
 *
 * アクセストークンは持たない。認証は glab のログイン状態に委ねる。
 * 複数インスタンスにログインしている場合に既定ホストを引かないよう、
 * 設定の url から取り出したホストを GITLAB_HOST で明示的に固定する
 * （--hostname はポート付きのホストを受け付けない）。
 */
export class GlabForgeClient implements ForgeClient {
  readonly kind: ForgeKind = 'gitlab';

  private readonly projectPath: string;
  private readonly env: Record<string, string>;

  constructor(
    config: GitLabForge,
    private readonly runner: CliRunner
  ) {
    this.projectPath = encodeURIComponent(String(config.projectId));
    this.env = { GITLAB_HOST: hostOf(config.url) };
  }

  async checkAuth(): Promise<string | null> {
    const result = await this.runner.run(GLAB, ['auth', 'status'], { env: this.env });

    return result.ok ? null : describeCliError(result.error);
  }

  async fetchByIid(iid: MergeRequestIid): Promise<MrState | null> {
    const mr = await this.get<RawMergeRequest>(`merge_requests/${iid}`);

    return mr === null ? null : this.enrich(mr);
  }

  async fetchByBranch(branch: string): Promise<MrState | null> {
    const query = `source_branch=${encodeURIComponent(branch)}&state=all&order_by=updated_at&per_page=1`;
    const list = await this.get<RawMergeRequest[]>(`merge_requests?${query}`);

    const mr = asArray(list)[0];

    return mr === undefined ? null : this.enrich(mr);
  }

  /**
   * MR 本体に加えてノートと最新コミットを取得する。
   * 再レビュー待ちの判定にはこの 2 つの日時比較が必要。
   */
  private async enrich(mr: RawMergeRequest): Promise<MrState> {
    const [notes, commits] = await Promise.all([
      this.get<RawNote[]>(`merge_requests/${mr.iid}/notes?sort=desc&per_page=20`),
      this.get<RawCommit[]>(`merge_requests/${mr.iid}/commits?per_page=1`),
    ]);

    // system note（「ブランチを push しました」等の自動生成）はレビューコメントではない
    const humanNotes = asArray(notes).filter((note) => !note.system);

    return {
      iid: toMergeRequestIid(mr.iid),
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
    const path = `projects/${this.projectPath}/${endpoint}`;
    const result = await this.runner.run(GLAB, ['api', path], { env: this.env });

    return unwrap(result.ok ? parseJson<T>(GLAB, result.value) : result);
  }
}

// ============================================================
// ヘルパー
// ============================================================

/** URL からホスト（ポートを含む）を取り出す */
function hostOf(url: string): string {
  return new URL(url).host;
}

function toLifecycleState(raw: string): MrLifecycleState {
  return (MR_STATES as readonly string[]).includes(raw) ? (raw as MrLifecycleState) : 'closed';
}
