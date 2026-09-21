import type { MergeRequestIid } from '../../shared/schemas/common.js';
import type { ForgeConfig } from '../../shared/config.js';
import type { ForgeKind, MrLifecycleState, MrState } from '../models/mr-state.js';
import { asArray, latestOf, toMergeRequestIid, type ForgeClient } from './forge-client.js';
import {
  parseJson,
  describeCliError,
  unwrap,
  type CliRunner,
} from '../../infrastructure/cli-runner.js';

// ============================================================
// GitHub — gh CLI 経由
// ============================================================

export const GH = 'gh';

interface RawPullRequest {
  number: number;
  state: string;
  merged_at: string | null;
  head: { ref: string; sha: string };
  title: string;
  html_url: string;
}

interface RawComment {
  created_at: string;
  /** Bot 判定に使う。GitHub App 由来のコメントは `type` が `Bot` になる */
  user?: { type?: string } | null;
}

interface RawCommit {
  commit?: { committer?: { date?: string } | null } | null;
}

type GitHubForge = Extract<ForgeConfig, { kind: 'github' }>;

/**
 * `gh api` を実行して Pull Request を取得する。
 *
 * アクセストークンは持たない。認証は gh のログイン状態に委ねる。
 */
export class GhForgeClient implements ForgeClient {
  readonly kind: ForgeKind = 'github';

  private readonly base: string;

  constructor(
    private readonly config: GitHubForge,
    private readonly runner: CliRunner
  ) {
    this.base = `repos/${config.owner}/${config.repo}`;
  }

  async checkAuth(): Promise<string | null> {
    const result = await this.runner.run(GH, ['auth', 'status']);

    return result.ok ? null : describeCliError(result.error);
  }

  async fetchByIid(iid: MergeRequestIid): Promise<MrState | null> {
    const pr = await this.get<RawPullRequest>(`pulls/${iid}`);

    return pr === null ? null : this.enrich(pr);
  }

  async fetchByBranch(branch: string): Promise<MrState | null> {
    // head の owner: 接頭辞を落とすと、他リポジトリの同名ブランチを拾う
    const head = encodeURIComponent(`${this.config.owner}:${branch}`);
    const query = `head=${head}&state=all&sort=updated&direction=desc&per_page=1`;
    const list = await this.get<RawPullRequest[]>(`pulls?${query}`);

    const pr = asArray(list)[0];

    return pr === undefined ? null : this.enrich(pr);
  }

  /**
   * PR 本体に加えてコメントと最新コミットを取得する。
   *
   * GitHub は人のコメントを 2 か所に分けて記録する。PR 全体への返信は issue comment、
   * コード行への指摘は review comment で、エンドポイントが別。GitLab の
   * 「system でない最新ノート」1 か所と意味を揃えるには両方が要る。
   *
   * どちらの一覧も既定では古い順に返り、1 ページ目しか読まない。
   * 最終時刻が要るので新しい順に並べ替えて取る（既定のままだと、コメントが
   * 100 件を超えた PR で最新ではなく 100 件目の時刻を最終時刻にしてしまう）。
   */
  private async enrich(pr: RawPullRequest): Promise<MrState> {
    const newestFirst = 'per_page=100&sort=created&direction=desc';

    const [issueComments, reviewComments, headCommit] = await Promise.all([
      this.get<RawComment[]>(`issues/${pr.number}/comments?${newestFirst}`),
      this.get<RawComment[]>(`pulls/${pr.number}/comments?${newestFirst}`),
      this.get<RawCommit>(`commits/${pr.head.sha}`),
    ]);

    // 自動生成のコメントは人のレビューではない。GitLab の system note に対応する
    const comments = [...asArray(issueComments), ...asArray(reviewComments)].filter(isHumanComment);

    return {
      iid: toMergeRequestIid(pr.number),
      state: toLifecycleState(pr.state, pr.merged_at),
      sourceBranch: pr.head.ref,
      title: pr.title,
      webUrl: pr.html_url,
      latestNoteAt: latestOf(comments.map((comment) => comment.created_at)),
      noteCount: comments.length,
      latestCommitAt: commitDate(headCommit),
    };
  }

  /** 404 は「存在しない」として null を返す。それ以外の失敗は例外にする */
  private async get<T>(endpoint: string): Promise<T | null> {
    const result = await this.runner.run(GH, ['api', `${this.base}/${endpoint}`]);

    return unwrap(result.ok ? parseJson<T>(GH, result.value) : result);
  }
}

// ============================================================
// ヘルパー
// ============================================================

/**
 * GitHub の `state` は open / closed の 2 値しか取らない。
 * マージ済みの PR も closed なので、`merged_at` が入っているかで区別する。
 * ここを取り違えるとマージ済みのカードが `merged` へ進まない。
 */
export function toLifecycleState(raw: string, mergedAt: string | null): MrLifecycleState {
  if (raw === 'open') return 'opened';

  return mergedAt === null ? 'closed' : 'merged';
}

/**
 * bot のコメントを外す。
 *
 * GitLab は自動生成を `system` フラグで示すが、GitHub には無く、
 * 代わりに GitHub App 由来のコメントの `user.type` が `Bot` になる。
 * CI の通知を人のレビューと数えると、再レビュー待ちの判定が狂う。
 */
function isHumanComment(comment: RawComment): boolean {
  return comment.user?.type !== 'Bot';
}

/**
 * PR の tip コミットの日時。
 *
 * `pulls/{n}/commits` は古い順の 1 ページ目しか返さないため、
 * コミットが 100 件を超えた PR で最新コミットを取り逃がす。
 * `head.sha` を直接引けば、件数によらず tip の日時が得られる。
 */
function commitDate(commit: RawCommit | null): string | null {
  return commit?.commit?.committer?.date ?? null;
}
