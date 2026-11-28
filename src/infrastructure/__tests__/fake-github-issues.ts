import { err, ok, type Result } from '../../shared/result.js';
import type { CliError, CliRunner, RunOptions } from '../cli-runner.js';

// ============================================================
// テスト用の GitHub — Issue とコメントだけを持つ、`gh api` の偽物
// ============================================================

export interface FakeComment {
  id: number;
  body: string;
  authorAssociation: string;
}

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  state: 'open' | 'closed';
  authorAssociation: string;
  comments: FakeComment[];
}

export interface FakeGithub {
  readonly runner: CliRunner;
  readonly issues: FakeIssue[];
  /** 走らせた `gh api` の呼び出し（`METHOD endpoint`。GraphQL は `graphql`） */
  readonly calls: string[];
  /** 通した書き込み（POST・PATCH・DELETE）の数 */
  writeCount: number;
  /** 書き込みの数がこれに達したら、以降の書き込みを失敗させる（`writeCount` と同じ数え方）。null なら失敗させない */
  failWritesAfter: number | null;
  /** 1 ページあたりの Issue の数を小さくして、ページ送りを試す */
  pageSize: number;
  /** GraphQL の 1 件のコメントの上限を小さくして、REST への切り替えを試す */
  commentsInGraphql: number;
  addComment(issue: number, body: string, authorAssociation?: string): void;
  addIssue(partial: Partial<FakeIssue> & Pick<FakeIssue, 'title' | 'body'>): FakeIssue;
}

const REPO = 'repos/acme/board';

function failed(message: string, httpStatus: number | null = null): Result<string, CliError> {
  return err({ type: 'Failed', command: 'gh', message, httpStatus });
}

/** `gh api` の呼び出しに答える、メモリの GitHub */
export function createFakeGithub(): FakeGithub {
  const issues: FakeIssue[] = [];
  let nextNumber = 1;
  let nextCommentId = 1000;

  const github: FakeGithub = {
    issues,
    calls: [],
    writeCount: 0,
    failWritesAfter: null,
    pageSize: 50,
    commentsInGraphql: 100,
    addIssue(partial) {
      const issue: FakeIssue = {
        number: nextNumber++,
        labels: ['ai-board'],
        state: 'open',
        authorAssociation: 'OWNER',
        comments: [],
        ...partial,
      };
      issues.push(issue);
      return issue;
    },
    addComment(number, body, authorAssociation = 'OWNER') {
      const issue = issues.find((candidate) => candidate.number === number);
      if (issue === undefined) throw new Error(`Issue #${number} がありません`);
      issue.comments.push({ id: nextCommentId++, body, authorAssociation });
    },
    runner: {
      run(command: string, args: readonly string[], options?: RunOptions) {
        return Promise.resolve(handle(command, args, options));
      },
    },
  };

  function handle(command: string, args: readonly string[], options?: RunOptions) {
    if (command !== 'gh' || args[0] !== 'api') return failed('想定外のコマンド');
    const rest = args.slice(1);

    if (rest[0] === 'graphql') {
      github.calls.push('graphql');
      return graphql(rest);
    }

    const methodAt = rest.indexOf('-X');
    const method = methodAt < 0 ? 'GET' : (rest[methodAt + 1] ?? 'GET');
    const endpoint = rest.filter((arg, i) => !arg.startsWith('-') && rest[i - 1] !== '-X')[0] ?? '';
    github.calls.push(`${method} ${endpoint}`);

    if (method === 'GET') return get(endpoint);

    if (github.failWritesAfter !== null && github.writeCount >= github.failWritesAfter) {
      return failed('終了コード 1 で失敗した', 500);
    }
    github.writeCount++;
    const body =
      options?.input === undefined ? {} : (JSON.parse(options.input) as Record<string, unknown>);
    return write(method, endpoint.slice(`${REPO}/`.length), body);
  }

  function graphql(args: readonly string[]): Result<string, CliError> {
    const cursorAt = args.findIndex((arg) => arg.startsWith('cursor='));
    const offset = cursorAt < 0 ? 0 : Number((args[cursorAt] ?? '').slice('cursor='.length));
    const labelled = issues.filter((issue) => issue.labels.includes('ai-board'));
    const page = labelled.slice(offset, offset + github.pageSize);
    const hasNextPage = offset + github.pageSize < labelled.length;
    return ok(
      JSON.stringify({
        data: {
          repository: {
            issues: {
              pageInfo: {
                hasNextPage,
                endCursor: hasNextPage ? String(offset + github.pageSize) : null,
              },
              nodes: page.map((issue) => ({
                number: issue.number,
                title: issue.title,
                body: issue.body,
                authorAssociation: issue.authorAssociation,
                comments: {
                  pageInfo: { hasNextPage: issue.comments.length > github.commentsInGraphql },
                  nodes: issue.comments.slice(0, github.commentsInGraphql).map((comment) => ({
                    databaseId: comment.id,
                    body: comment.body,
                    authorAssociation: comment.authorAssociation,
                  })),
                },
              })),
            },
          },
        },
      })
    );
  }

  function get(endpoint: string): Result<string, CliError> {
    const match = /^repos\/acme\/board\/issues\/(\d+)\/comments\?per_page=(\d+)&page=(\d+)$/.exec(
      endpoint
    );
    if (match === null) return failed('想定外の GET', 404);
    const issue = issues.find((candidate) => candidate.number === Number(match[1]));
    if (issue === undefined) return failed('Not Found', 404);
    const perPage = Number(match[2]);
    const page = Number(match[3]);
    return ok(
      JSON.stringify(
        issue.comments.slice((page - 1) * perPage, page * perPage).map((comment) => ({
          id: comment.id,
          body: comment.body,
          author_association: comment.authorAssociation,
        }))
      )
    );
  }

  function write(
    method: string,
    endpoint: string,
    body: Record<string, unknown>
  ): Result<string, CliError> {
    if (method === 'POST' && endpoint === 'labels') return ok('{}');
    if (method === 'POST' && endpoint === 'issues') return createIssue(body);
    const issueMatch = /^issues\/(\d+)(\/comments)?$/.exec(endpoint);
    if (issueMatch !== null) {
      return writeIssue(method, Number(issueMatch[1]), issueMatch[2] !== undefined, body);
    }
    const commentMatch = /^issues\/comments\/(\d+)$/.exec(endpoint);
    if (commentMatch !== null) return writeComment(method, Number(commentMatch[1]), body);
    return failed('想定外の書き込み', 404);
  }

  function createIssue(body: Record<string, unknown>): Result<string, CliError> {
    const issue = github.addIssue({
      title: String(body['title']),
      body: String(body['body']),
      labels: (body['labels'] as string[] | undefined) ?? [],
    });
    return ok(JSON.stringify({ number: issue.number }));
  }

  function writeIssue(
    method: string,
    number: number,
    comments: boolean,
    body: Record<string, unknown>
  ): Result<string, CliError> {
    const issue = issues.find((candidate) => candidate.number === number);
    if (issue === undefined) return failed('Not Found', 404);
    if (method === 'POST' && comments) {
      const comment = {
        id: nextCommentId++,
        body: String(body['body']),
        authorAssociation: 'OWNER',
      };
      issue.comments.push(comment);
      return ok(JSON.stringify({ id: comment.id }));
    }
    if (method === 'PATCH' && !comments) {
      if (typeof body['title'] === 'string') issue.title = body['title'];
      if (typeof body['body'] === 'string') issue.body = body['body'];
      if (body['state'] === 'closed') issue.state = 'closed';
      return ok(JSON.stringify({ number: issue.number }));
    }
    return failed('想定外の書き込み', 404);
  }

  function writeComment(
    method: string,
    id: number,
    body: Record<string, unknown>
  ): Result<string, CliError> {
    for (const issue of issues) {
      const at = issue.comments.findIndex((comment) => comment.id === id);
      const comment = issue.comments[at];
      if (comment === undefined) continue;
      if (method === 'DELETE') {
        issue.comments.splice(at, 1);
        return ok('');
      }
      comment.body = String(body['body']);
      return ok(JSON.stringify({ id }));
    }
    return failed('Not Found', 404);
  }

  return github;
}
