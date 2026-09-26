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

/** 一覧 1 ページあたりの件数。GitHub の上限 */
const PER_PAGE = 100;

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

/**
 * `gh api` を実行して Pull Request を取得する。
 *
 * アクセストークンは持たない。認証は gh のログイン状態に委ねる。
 */
export class GhForgeClient implements ForgeClient {
  readonly kind: ForgeKind = 'github';

  private readonly base: string;

  constructor(
    private readonly config: ForgeConfig,
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
   * コード行への指摘は review comment で、エンドポイントが別。
   * 人が書いた最新のコメントを知るには両方が要る。
   *
   * どちらの一覧も既定では古い順に 1 ページ目だけを返す。
   * `issues/{n}/comments` は `sort` / `direction` を受け付けない
   * （並べ替えを受けるのは同名のリポジトリ単位のエンドポイントの方）ため、
   * 並び順に頼ると 100 件を超えた PR で最新ではなく 100 件目を最終時刻にしてしまう。
   * 順序ではなく全ページを読んで最大値を取る（`latestOf` が最大値を選ぶので
   * 並び順は問わない）。件数も同じ理由で全ページを数えないと頭打ちになる。
   */
  private async enrich(pr: RawPullRequest): Promise<MrState> {
    const [issueComments, reviewComments, headCommit] = await Promise.all([
      this.getAll<RawComment>(`issues/${pr.number}/comments`),
      this.getAll<RawComment>(`pulls/${pr.number}/comments`),
      this.get<RawCommit>(`commits/${pr.head.sha}`),
    ]);

    // 自動生成のコメントは人のレビューではない
    const comments = [...issueComments, ...reviewComments].filter(isHumanComment);

    return {
      forge: this.kind,
      iid: toMergeRequestIid(pr.number),
      state: toLifecycleState(pr.state, pr.merged_at),
      sourceBranch: pr.head.ref,
      title: pr.title,
      webUrl: pr.html_url,
      latestNoteAt: latestOf(comments.map((comment) => comment.created_at)),
      noteCount: comments.length,
      latestCommitAt: commitDate(headCommit),
      mergedAt: pr.merged_at,
    };
  }

  /** 404 は「存在しない」として null を返す。それ以外の失敗は例外にする */
  private async get<T>(endpoint: string): Promise<T | null> {
    const result = await this.runner.run(GH, ['api', `${this.base}/${endpoint}`]);

    return unwrap(result.ok ? parseJson<T>(GH, result.value) : result);
  }

  /**
   * 一覧を全ページ取得する。
   *
   * `gh api --paginate` は Link ヘッダを辿り、JSON 配列を 1 つの配列へ繋いで返す。
   * ページ数を呼び出し側で数えずに済む。
   */
  private async getAll<T>(endpoint: string): Promise<T[]> {
    const path = `${this.base}/${endpoint}?per_page=${PER_PAGE}`;
    const result = await this.runner.run(GH, ['api', '--paginate', path]);

    return asArray(unwrap(result.ok ? parseJson<T[]>(GH, result.value) : result));
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
 * GitHub には自動生成を示すフラグが無く、
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
