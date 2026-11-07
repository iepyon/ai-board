import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PullRequestNumber } from '../../shared/schemas/common.js';
import type { ForgeConfig } from '../../shared/config.js';
import type { ForgeKind, PrLifecycleState, PrSnapshot, PrState } from '../models/pr-state.js';
import {
  asArray,
  ForgeRequestError,
  latestOf,
  toPullRequestNumber,
  type ForgeClient,
} from './forge-client.js';
import {
  parseJson,
  describeCliError,
  isNotFound,
  type CliError,
  type CliRunner,
} from '../../infrastructure/cli-runner.js';
import {
  summarizeChecks,
  type ChecksSummary,
  type RawCheckRun,
  type RawCommitStatus,
} from './pr-checks.js';
import { err, isErr, ok, type Result } from '../../shared/result.js';

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
const FINGERPRINT_VERSION = 3;

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
  /** AI のコメントの見分け（`CLAUDE_CODE_FOOTER`）に使う */
  body?: string | null;
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
   * 同じ認証で `gh api` は動く。PR を引くのも `gh api` なので、同じ経路で確かめる。
   */
  async checkAuth(): Promise<string | null> {
    const result = await this.runner.run(GH, ['api', this.base]);

    return result.ok ? null : describeCliError(result.error);
  }

  /**
   * PR 本体を 1 回引き、指紋が `previous` と同じなら `previous` をそのまま返す。
   *
   * コメント・コミット・イベントの問い合わせは PR 1 枚につき 4 回以上かかる。
   * 変化の無い PR でこれを毎回繰り返すと、問い合わせのたびに PR の枚数の 4 倍以上を使い、GitHub の上限（5,000 回/時）に近づく。
   */
  async fetchByIid(
    iid: PullRequestNumber,
    previous: PrSnapshot | null = null
  ): Promise<PrSnapshot | null> {
    const pr = await this.get<RawPullRequest>(`pulls/${iid}`);
    if (pr === null) return null;

    const fingerprint = fingerprintOf(pr);
    if (previous !== null && previous.mr.iid === iid && previous.fingerprint === fingerprint) {
      return previous;
    }

    return this.enrich(pr, fingerprint);
  }

  async fetchByBranch(branch: string): Promise<PrSnapshot | null> {
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
  private async enrich(pr: RawPullRequest, fingerprint: string): Promise<PrSnapshot> {
    const state = toLifecycleState(pr.state, pr.merged_at);
    const draft = pr.draft === true;

    const [issueComments, reviewComments, headCommit, events] = await Promise.all([
      this.getAll<RawComment>(`issues/${pr.number}/comments`),
      this.getAll<RawComment>(`pulls/${pr.number}/comments`),
      this.get<RawCommit>(`commits/${pr.head.sha}`),
      this.getAll<RawIssueEvent>(`issues/${pr.number}/events`),
    ]);

    // 自動生成のコメントは人のレビューではない。AI が人のアカウントで書いたコメントは別に数える
    const notes = [...issueComments, ...reviewComments].filter(isHumanComment);
    const comments = notes.filter((comment) => !isAiComment(comment));
    const aiComments = notes.filter(isAiComment);

    const mr = {
      forge: this.kind,
      iid: toPullRequestNumber(pr.number),
      state,
      draft,
      sourceBranch: pr.head.ref,
      title: pr.title,
      webUrl: pr.html_url,
      latestNoteAt: latestOf(comments.map((comment) => comment.created_at)),
      noteCount: comments.length,
      latestAiNoteAt: latestOf(aiComments.map((comment) => comment.created_at)),
      latestCommitAt: commitDate(headCommit),
      mergedAt: pr.merged_at,
      ...draftTransitionsOf(events, state, draft, pr.created_at ?? null),
    };

    return { mr, fingerprint };
  }

  /** 404 は「存在しない」として null を返す。それ以外の失敗は例外にする */
  private async get<T>(endpoint: string): Promise<T | null> {
    const result = await this.runner.run(GH, ['api', `${this.base}/${endpoint}`]);

    return unwrapRequest(endpoint, result.ok ? parseJson<T>(GH, result.value) : result);
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

    return asArray(unwrapRequest(endpoint, result.ok ? parseJson<T[]>(GH, result.value) : result));
  }
}

// ============================================================
// ヘルパー
// ============================================================

/**
 * 問い合わせの結果を値へ開く。404 は「存在しない」として null、それ以外の失敗は `ForgeRequestError` にして投げる。
 * `PrFetcher` はこの例外の `scope` で、接続をまるごと止めるか、そのカードだけを止めるかを決める
 */
function unwrapRequest<T>(endpoint: string, result: Result<T, CliError>): T | null {
  if (isErr(result)) {
    if (isNotFound(result.error)) return null;
    throw new ForgeRequestError(endpoint, result.error);
  }

  return result.value;
}

/**
 * GitHub の `state` は open / closed の 2 値しか取らない。
 * マージ済みの PR も closed なので、`merged_at` が入っているかで区別する。
 * ここを取り違えるとマージ済みのカードが `merged` へ進まない。
 */
export function toLifecycleState(raw: string, mergedAt: string | null): PrLifecycleState {
  if (raw === 'open') return 'opened';

  return mergedAt === null ? 'closed' : 'merged';
}

/**
 * PR 本体だけで分かる、`enrich` の結果を変えうる値をつなぐ。
 *
 * 新しいコメントは件数を、push は `head.sha` を、Draft の出し入れは `draft` を変える。
 * `updated_at` は、件数が変わらないまま消して書き直したコメントや、
 * 前に引いてから今までの間に Draft へ戻して Ready に戻したといった取りこぼしを拾うために足している。
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
 * AI が書いたコメントの印。Claude Code が GitHub に書く文の末尾に付けるフッターの 1 行である。
 *
 * PR もコメントも人のアカウントで書かれるので、`user.type` や login では AI と人を見分けられない。
 * `ai-board pr comment` は本文にこれが無ければ足す（`withClaudeCodeFooter`）。
 */
export const CLAUDE_CODE_FOOTER = '_Generated by [Claude Code](https://claude.ai/code)_';

/**
 * AI が人のアカウントで書いたコメントか。末尾の空白を落とした本文の最後の行が、フッターそのものであるものとする。
 *
 * 本文のどこかに含むだけでは読まない。人が AI の返信を引用して返すと、引用（`> ` で始まる行）の中にフッターが入り、
 * 人の指摘が AI のコメントと読まれて、カードが AI の番にならないため。
 */
export function isAiComment(comment: { readonly body?: string | null }): boolean {
  return endsWithFooter(comment.body ?? '');
}

/** 本文にフッターが無ければ（最後の行がフッターでなければ）、区切りの線とともに末尾に足す */
export function withClaudeCodeFooter(body: string): string {
  if (endsWithFooter(body)) return body;
  return `${body.trimEnd()}\n\n---\n${CLAUDE_CODE_FOOTER}\n`;
}

function endsWithFooter(body: string): boolean {
  const lines = body.trimEnd().split('\n');
  return lines[lines.length - 1]?.trim() === CLAUDE_CODE_FOOTER;
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
  state: PrLifecycleState,
  draft: boolean,
  createdAt: string | null
): Pick<PrState, 'readyAt' | 'convertedToDraftAt'> {
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

// ============================================================
// PR の読み書き — `ai-board pr` が使う
// ============================================================

/** `ai-board pr checks` が引いたもの。`summary` は、指定したコミットがまだ PR の head でなければ null */
export interface PullRequestChecks {
  readonly headSha: string;
  readonly summary: ChecksSummary | null;
}

/** `ai-board pr view` に出す PR の項目 */
export interface PullRequestView {
  readonly number: number;
  readonly title: string;
  readonly state: PrLifecycleState;
  readonly draft: boolean;
  readonly head: string;
  readonly base: string;
  readonly url: string;
  readonly author: string | null;
  readonly body: string;
}

/** PR のコメント。`path` は review comment（コード行への指摘）にだけある */
export interface PullRequestComment {
  readonly author: string | null;
  readonly createdAt: string;
  readonly body: string;
  readonly url: string;
  readonly path: string | null;
  readonly line: number | null;
}

export interface CreatePullRequestInput {
  readonly head: string;
  /** null なら、リポジトリの既定のブランチ（`gh pr create` と同じ） */
  readonly base: string | null;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
}

/** Ready にした経路。`gh` は `gh pr ready`（GraphQL）、`ccr` は `ccr/ready_for_review` */
export type ReadyRoute = 'gh' | 'ccr';

/** Ready にする 2 つの経路が、どちらも失敗した理由 */
export interface ReadyFailure {
  readonly gh: CliError;
  readonly ccr: CliError;
}

interface RawPullRequestDetail extends RawPullRequest {
  base: { ref: string };
  body?: string | null;
  user?: { login?: string } | null;
}

interface RawRepository {
  default_branch: string;
}

interface RawCommentDetail {
  created_at: string;
  body?: string | null;
  html_url: string;
  user?: { login?: string } | null;
  path?: string;
  line?: number | null;
  original_line?: number | null;
}

interface RawCreated {
  html_url: string;
}

interface RawCreatedPullRequest extends RawCreated {
  number: number;
}

const DIFF_ACCEPT = 'Accept: application/vnd.github.diff';

/**
 * `gh` で PR を作る・読む・書き換える。手順書の `gh pr` を置き換える。
 *
 * クラウドのセッションでは GraphQL が 403 になり `gh pr` が動かないので、REST（`gh api`）で行う。
 * Ready にする操作だけは REST の `PATCH draft=false` で Draft が外れないため、
 * `gh pr ready` を先に試し、失敗したら `ccr/ready_for_review` を試す。
 *
 * 本文は引数に載せず、JSON にして一時ファイルへ書き、`gh api --input` で渡す。
 * `--input` を使うと `-f` / `-F` の項目はクエリ文字列に回るので、送る項目はすべて JSON に入れる。
 */
export class GhPullRequestClient {
  private readonly base: string;

  constructor(
    private readonly config: ForgeConfig,
    private readonly runner: CliRunner
  ) {
    this.base = `repos/${config.owner}/${config.repo}`;
  }

  /** PR を作り、番号と URL を返す。`base` が null ならリポジトリの既定のブランチへ向ける */
  async create(
    input: CreatePullRequestInput
  ): Promise<Result<{ number: number; url: string }, CliError>> {
    let base = input.base;
    if (base === null) {
      const repository = await this.getJson<RawRepository>(this.base);
      if (isErr(repository)) return repository;
      base = repository.value.default_branch;
    }

    const created = await this.send<RawCreatedPullRequest>('POST', `${this.base}/pulls`, {
      title: input.title,
      head: input.head,
      base,
      body: input.body,
      draft: input.draft,
    });
    if (isErr(created)) return created;

    return ok({ number: created.value.number, url: created.value.html_url });
  }

  async view(iid: PullRequestNumber): Promise<Result<PullRequestView, CliError>> {
    const pr = await this.getJson<RawPullRequestDetail>(`${this.base}/pulls/${iid}`);
    if (isErr(pr)) return pr;

    const raw = pr.value;
    return ok({
      number: raw.number,
      title: raw.title,
      state: toLifecycleState(raw.state, raw.merged_at),
      draft: raw.draft === true,
      head: raw.head.ref,
      base: raw.base.ref,
      url: raw.html_url,
      author: raw.user?.login ?? null,
      body: raw.body ?? '',
    });
  }

  /**
   * PR 全体への返信（issue comment）とコード行への指摘（review comment）を、時刻の順に並べて返す。
   * どちらの一覧も既定は 1 ページ目だけなので、全ページを読む。
   */
  async comments(iid: PullRequestNumber): Promise<Result<PullRequestComment[], CliError>> {
    const [issueComments, reviewComments] = await Promise.all([
      this.getAllJson<RawCommentDetail>(`${this.base}/issues/${iid}/comments`),
      this.getAllJson<RawCommentDetail>(`${this.base}/pulls/${iid}/comments`),
    ]);
    if (isErr(issueComments)) return issueComments;
    if (isErr(reviewComments)) return reviewComments;

    const comments = [...issueComments.value, ...reviewComments.value].map(toComment);
    return ok(comments.sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
  }

  /** PR の本文を差し替え、PR の URL を返す */
  async editBody(iid: PullRequestNumber, body: string): Promise<Result<string, CliError>> {
    const edited = await this.send<RawCreated>('PATCH', `${this.base}/pulls/${iid}`, { body });

    return isErr(edited) ? edited : ok(edited.value.html_url);
  }

  /** PR にコメントを書き、コメントの URL を返す */
  async comment(iid: PullRequestNumber, body: string): Promise<Result<string, CliError>> {
    const created = await this.send<RawCreated>('POST', `${this.base}/issues/${iid}/comments`, {
      body,
    });

    return isErr(created) ? created : ok(created.value.html_url);
  }

  /**
   * PR のチェックを、`check-runs` と `status` から全件引いてまとめる。
   *
   * 見るコミットは `sha`（省けば PR の `head.sha`）。push の直後は GitHub がまだ PR の head を動かしていないことがあるので、
   * `sha` を指定して PR の head がそれと違えば、チェックを引かずに `summary: null` を返す（呼び出し側は走っているとして待つ）。
   * `sha` は短いハッシュでもよく、head の完全なハッシュの先頭と照らし合わせる（`isSameCommit`）。
   * どちらの応答も配列ではなく `{ ..., check_runs }` / `{ ..., statuses }` なので、`--paginate` の各ページを
   * `--jq` で 1 件 1 行にして繋ぐ（ページを跨いでも 1 本の JSON にならないため）。
   */
  async checks(
    iid: PullRequestNumber,
    sha: string | null = null
  ): Promise<Result<PullRequestChecks, CliError>> {
    const pr = await this.getJson<RawPullRequestDetail>(`${this.base}/pulls/${iid}`);
    if (isErr(pr)) return pr;
    const headSha = pr.value.head.sha;
    if (sha !== null && !isSameCommit(sha, headSha)) return ok({ headSha, summary: null });

    const [runs, status] = await Promise.all([
      this.getJsonLines<RawCheckRun>(`commits/${headSha}/check-runs`, '.check_runs[]'),
      this.getJsonLines<RawCommitStatus>(`commits/${headSha}/status`, '.statuses[]'),
    ]);
    if (isErr(runs)) return runs;

    const statusResult = readableStatuses(status);
    if (isErr(statusResult)) return statusResult;
    const { statuses, statusUnreadable } = statusResult.value;

    return ok({
      headSha,
      summary: summarizeChecks(headSha, runs.value, statuses, statusUnreadable),
    });
  }

  /** 全ページを `--jq <filter>` で 1 件 1 行にして引き、読む */
  private async getJsonLines<T>(endpoint: string, filter: string): Promise<Result<T[], CliError>> {
    const result = await this.runner.run(GH, [
      'api',
      '--paginate',
      '--jq',
      filter,
      `${this.base}/${endpoint}?per_page=${PER_PAGE}`,
    ]);
    return isErr(result) ? result : parseJsonLines<T>(result.value);
  }

  /** PR の差分を unified diff の文字列で返す */
  async diff(iid: PullRequestNumber): Promise<Result<string, CliError>> {
    return this.runner.run(GH, ['api', '-H', DIFF_ACCEPT, `${this.base}/pulls/${iid}`]);
  }

  /**
   * PR を Ready にする。`gh pr ready`（GraphQL）を試し、失敗したら `ccr/ready_for_review` を試す。
   *
   * 手元では `gh pr ready` が通り、クラウドでは GraphQL が 403 で `ccr/` の経路が通る見込みである。
   * どちらも失敗したら、両方の理由を返す。
   */
  async ready(iid: PullRequestNumber): Promise<Result<ReadyRoute, ReadyFailure>> {
    const repo = `${this.config.owner}/${this.config.repo}`;
    const viaGh = await this.runner.run(GH, ['pr', 'ready', String(iid), '--repo', repo]);
    if (!isErr(viaGh)) return ok('gh');

    const viaCcr = await this.runner.run(GH, [
      'api',
      '--method',
      'POST',
      `${this.base}/pulls/${iid}/ccr/ready_for_review`,
    ]);
    if (!isErr(viaCcr)) return ok('ccr');

    return err({ gh: viaGh.error, ccr: viaCcr.error });
  }

  private async getJson<T>(endpoint: string): Promise<Result<T, CliError>> {
    const result = await this.runner.run(GH, ['api', endpoint]);

    return isErr(result) ? result : parseJson<T>(GH, result.value);
  }

  private async getAllJson<T>(endpoint: string): Promise<Result<T[], CliError>> {
    const result = await this.runner.run(GH, [
      'api',
      '--paginate',
      `${endpoint}?per_page=${PER_PAGE}`,
    ]);
    if (isErr(result)) return result;

    const parsed = parseJson<T[]>(GH, result.value);
    return isErr(parsed) ? parsed : ok(asArray(parsed.value));
  }

  /** 項目を JSON にして一時ファイルへ書き、`gh api --input` で送る。一時ファイルは必ず消す */
  private async send<T>(
    method: 'POST' | 'PATCH',
    endpoint: string,
    payload: Readonly<Record<string, unknown>>
  ): Promise<Result<T, CliError>> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-board-pr-'));

    try {
      const input = path.join(dir, 'input.json');
      await fs.writeFile(input, JSON.stringify(payload), 'utf-8');

      const result = await this.runner.run(GH, [
        'api',
        '--method',
        method,
        endpoint,
        '--input',
        input,
      ]);
      return isErr(result) ? result : parseJson<T>(GH, result.value);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}

/** `gh api --jq` が 1 件 1 行で出した JSON を読む */
function parseJsonLines<T>(text: string): Result<T[], CliError> {
  const items: T[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const parsed = parseJson<T>(GH, line);
    if (isErr(parsed)) return parsed;
    items.push(parsed.value);
  }
  return ok(items);
}

/**
 * `status` の応答から一覧を取り出す。権限で読めない（403）・見つからない（404）ときは空にして理由を返し、
 * `check-runs` だけで判定させる（クラウドのセッションの GitHub App は Commit Status API を読めないことがある）。ほかの失敗はそのまま返す
 */
function readableStatuses(
  status: Result<RawCommitStatus[], CliError>
): Result<
  { readonly statuses: readonly RawCommitStatus[]; readonly statusUnreadable: string | null },
  CliError
> {
  if (!isErr(status)) return ok({ statuses: status.value, statusUnreadable: null });

  const http = status.error.type === 'Failed' ? status.error.httpStatus : null;
  if (http === 403 || http === 404) return ok({ statuses: [], statusUnreadable: `HTTP ${http}` });
  return status;
}

function toComment(raw: RawCommentDetail): PullRequestComment {
  return {
    author: raw.user?.login ?? null,
    createdAt: raw.created_at,
    body: raw.body ?? '',
    url: raw.html_url,
    path: raw.path ?? null,
    line: raw.line ?? raw.original_line ?? null,
  };
}

/**
 * `sha`（完全なハッシュか、7 桁以上の短いハッシュ）が、完全なハッシュ `headSha` と同じコミットを指すか。
 *
 * 比べる相手は PR の head の 1 つだけなので、先頭が一致すれば同じコミットと読む。
 * 7 桁で別のコミットが先頭まで一致する見込みは 16^7 分の 1 で、`git` 自身も短いハッシュを一意に決まる範囲で受け付ける。
 */
export function isSameCommit(sha: string, headSha: string): boolean {
  return headSha.startsWith(sha);
}
