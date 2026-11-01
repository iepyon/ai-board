import type { MergeRequestIid } from '../../shared/schemas/common.js';
import type { ForgeConfig } from '../../shared/config.js';
import type { ForgeKind, MrLifecycleState, MrSnapshot, MrState } from '../models/mr-state.js';
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

/**
 * 指紋の作り方の版。`enrich` の組み立て方を変えたら上げる。
 * 上げると保存済みの控えの指紋がすべて合わなくなり、1 度ずつ引き直される。
 */
const FINGERPRINT_VERSION = 2;

interface RawPullRequest {
  number: number;
  state: string;
  merged_at: string | null;
  /** 古い API 応答や GHES では欠けることがある */
  draft?: boolean;
  head: { ref: string; sha: string };
  title: string;
  html_url: string;
  /** 作成時から Ready の PR は `ready_for_review` を残さないので、Ready にした時刻の代わりに使う */
  created_at?: string;
  updated_at?: string;
  /** issue comment の件数。`pulls/{n}` にだけあり、一覧（`pulls?head=`）には無い */
  comments?: number;
  /** review comment の件数。同上 */
  review_comments?: number;
}

interface RawComment {
  created_at: string;
  /** Bot 判定に使う。GitHub App 由来のコメントは `type` が `Bot` になる */
  user?: { type?: string } | null;
}

interface RawIssueEvent {
  event: string;
  created_at: string;
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

  /**
   * リポジトリを REST で 1 回引けるかで確かめる。
   *
   * `gh auth status` は使わない。クラウドのセッションでは「GH_TOKEN が無効」と失敗するが、
   * 同じ認証で `gh api` は動く。ポーリングで使うのも `gh api` なので、同じ経路で確かめる。
   */
  async checkAuth(): Promise<string | null> {
    const result = await this.runner.run(GH, ['api', this.base]);

    return result.ok ? null : describeCliError(result.error);
  }

  /**
   * PR 本体を 1 回引き、指紋が `previous` と同じなら `previous` をそのまま返す。
   *
   * コメント・コミット・イベントの問い合わせは PR 1 枚につき 4 回以上かかる。
   * 変化の無い PR でこれを毎回繰り返すと、ポーリングのたびに PR の枚数の 4 倍以上を使い、GitHub の上限（5,000 回/時）に近づく。
   */
  async fetchByIid(
    iid: MergeRequestIid,
    previous: MrSnapshot | null = null
  ): Promise<MrSnapshot | null> {
    const pr = await this.get<RawPullRequest>(`pulls/${iid}`);
    if (pr === null) return null;

    const fingerprint = fingerprintOf(pr);
    if (previous !== null && previous.mr.iid === iid && previous.fingerprint === fingerprint) {
      return previous;
    }

    return this.enrich(pr, fingerprint);
  }

  async fetchByBranch(branch: string): Promise<MrSnapshot | null> {
    // head の owner: 接頭辞を落とすと、他リポジトリの同名ブランチを拾う
    const head = encodeURIComponent(`${this.config.owner}:${branch}`);
    const query = `head=${head}&state=all&sort=updated&direction=desc&per_page=1`;
    const list = await this.get<RawPullRequest[]>(`pulls?${query}`);

    const pr = asArray(list)[0];

    return pr === undefined ? null : this.enrich(pr, fingerprintOf(pr));
  }

  /**
   * PR 本体に加えてコメント・最新コミット・イベントを取得する。
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
  private async enrich(pr: RawPullRequest, fingerprint: string): Promise<MrSnapshot> {
    const state = toLifecycleState(pr.state, pr.merged_at);
    const draft = pr.draft === true;

    const [issueComments, reviewComments, headCommit, events] = await Promise.all([
      this.getAll<RawComment>(`issues/${pr.number}/comments`),
      this.getAll<RawComment>(`pulls/${pr.number}/comments`),
      this.get<RawCommit>(`commits/${pr.head.sha}`),
      this.getAll<RawIssueEvent>(`issues/${pr.number}/events`),
    ]);

    // 自動生成のコメントは人のレビューではない
    const comments = [...issueComments, ...reviewComments].filter(isHumanComment);

    const mr = {
      forge: this.kind,
      iid: toMergeRequestIid(pr.number),
      state,
      draft,
      sourceBranch: pr.head.ref,
      title: pr.title,
      webUrl: pr.html_url,
      latestNoteAt: latestOf(comments.map((comment) => comment.created_at)),
      noteCount: comments.length,
      latestCommitAt: commitDate(headCommit),
      mergedAt: pr.merged_at,
      ...draftTransitionsOf(events, state, draft, pr.created_at ?? null),
    };

    return { mr, fingerprint };
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
 * PR 本体だけで分かる、`enrich` の結果を変えうる値をつなぐ。
 *
 * 新しいコメントは件数を、push は `head.sha` を、Draft の出し入れは `draft` を変える。
 * `updated_at` は、件数が変わらないまま消して書き直したコメントや、
 * ポーリングの間に Draft へ戻して Ready に戻したといった取りこぼしを拾うために足している。
 * 余計に変わっても引き直しが 1 回増えるだけで、正しさは崩れない。
 *
 * 一覧（`pulls?head=`）の応答には件数が無いので、ブランチから解決した直後の指紋は
 * 番号で引いたときの指紋と一致せず、次の周で 1 度だけ引き直す。
 */
function fingerprintOf(pr: RawPullRequest): string {
  return JSON.stringify([
    FINGERPRINT_VERSION,
    pr.state,
    pr.merged_at,
    pr.draft === true,
    pr.head.sha,
    pr.comments ?? null,
    pr.review_comments ?? null,
    pr.updated_at ?? null,
  ]);
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
 * PR のイベントから、最後に Ready にした時刻と最後に Draft へ戻された時刻を取る。
 *
 * `readyAt` は Ready の PR とマージ済みの PR でこそ要るので、イベントの一覧は PR の状態を問わず引く。
 * 作成時から Ready の PR は `ready_for_review` を残さないので、Draft でなければ作成時刻で補う。
 *
 * `convertedToDraftAt` は今 open かつ Draft のときだけ値を持つ（止まりの判定がその前提で読む）。
 * 作成時から Draft の PR は `convert_to_draft` を残さない。
 * イベントの一覧も既定は古い順の 1 ページ目なので、全ページ読んで最大値を取る。
 */
function draftTransitionsOf(
  events: readonly RawIssueEvent[],
  state: MrLifecycleState,
  draft: boolean,
  createdAt: string | null
): Pick<MrState, 'readyAt' | 'convertedToDraftAt'> {
  const latestEvent = (name: string): string | null =>
    latestOf(events.filter((event) => event.event === name).map((event) => event.created_at));

  return {
    readyAt: latestEvent('ready_for_review') ?? (draft ? null : createdAt),
    convertedToDraftAt: state === 'opened' && draft ? latestEvent('convert_to_draft') : null,
  };
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
