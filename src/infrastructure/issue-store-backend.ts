import { z } from 'zod';
import { err, isErr, ok, type Result } from '../shared/result.js';
import { CardIdSchema } from '../shared/schemas/common.js';
import { describeCliErrorWithStatus, parseJson, type CliRunner } from './cli-runner.js';
import { isValidDocumentId, type DocumentData, type StoreError } from './document-store.js';
import {
  BackedDocumentStore,
  DELETED,
  keyOf,
  parseKey,
  type StoreBackend,
  type Written,
} from './backed-document-store.js';
import { LOCAL_COLLECTIONS } from './dir-store-backend.js';
import type { LockOptions } from './file-lock.js';

// ============================================================
// GitHub の Issue による置き場所 — カード 1 枚が Issue 1 件
// ============================================================

/**
 * 共有の文書（カード・判断・並び順・形の版）を、リポジトリの Issue に置く。
 *
 * ```
 * cards/<id>        Issue。タイトル=カードのタイトル、本文=カードの本文＋末尾の隠しコメント
 *                   `<!-- ai-board:card {id, created, skipGates, branch, pr} -->`
 * log/<id>.<名前>   その Issue のコメント 1 件。見出しの行と理由の本文＋末尾の隠しコメント
 *                   `<!-- ai-board:log {id, cardId, at, gate, kind} -->`
 * board/meta        専用の Issue（`ai-board` のラベル）の隠しコメント
 * order/order       `<!-- ai-board:store {docs: {"board/meta": …, "order/order": …}} -->`
 * ```
 *
 * 文書の形は `cards/repositories/card-files.ts` の `CardDocument`・判断の文書に合わせている
 * （カードは `title` と `body`、判断は `reason` を人が読める場所に出す）。
 *
 * **信用する作者。** 公開リポジトリでは外の人も Issue とコメントを書ける。判断のコメントを偽造されないよう、
 * 作者の `authorAssociation` が OWNER / MEMBER / COLLABORATOR のものだけを読む。
 *
 * **同時書き込み。** Issue の更新に楽観ロックは無い。書き込みは読み直してから走る（`BackedDocumentStore`）が、
 * 同じカードの本文や並び順を同時に書けば、後の書き込みが勝つ。判断はコメントの追加なので重ならない。
 */

const GH = 'gh';

/** カードと置き場所の Issue に付けるラベル。この名前の Issue だけを読む */
export const ISSUE_LABEL = 'ai-board';

/** 判断のコメントを読む作者 */
const TRUSTED_ASSOCIATIONS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

const STORE_ISSUE_TITLE =
  'ai-board: 置き場所（この Issue は ai-board が読み書きします。編集しないでください）';

const STORE_ISSUE_NOTE =
  '並び順と形の版を、末尾の隠しコメントに持っています。`ai-board` のラベルが付いた Issue はカードです。';

/** 一覧 1 ページあたりの Issue の数。コメントを 100 件まで一緒に引くので、大きくしない */
const ISSUES_PER_PAGE = 50;
const COMMENTS_PER_PAGE = 100;

// ------------------------------------------------------------
// 隠しコメント
// ------------------------------------------------------------

type MarkerKind = 'card' | 'log' | 'store';

const END_MARKER = /(?:\r?\n)*<!-- ai-board:(card|log|store) (\{[^\r\n]*\}) -->\s*$/;

/** `<!-- ai-board:<種別> {…} -->`。`-->` で隠しコメントが終わらないよう、`<` と `>` を JSON の escape にする */
export function encodeMarker(kind: MarkerKind, data: unknown): string {
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `<!-- ai-board:${kind} ${json} -->`;
}

/** 末尾の隠しコメントを外す。無い・JSON として読めなければ null */
export function splitMarker(
  text: string
): { readonly kind: MarkerKind; readonly data: unknown; readonly rest: string } | null {
  const match = END_MARKER.exec(text);
  const kind = match?.[1];
  const json = match?.[2];
  if (match === null || kind === undefined || json === undefined) return null;
  try {
    return {
      kind: kind as MarkerKind,
      data: JSON.parse(json) as unknown,
      rest: text.slice(0, match.index),
    };
  } catch {
    return null;
  }
}

const CardMetaSchema = z.object({
  id: z.string(),
  created: z.string(),
  skipGates: z.array(z.string()).default([]),
  branch: z.string().nullable().default(null),
  pr: z.number().int().nullable().default(null),
});

const LogMetaSchema = z.object({
  id: z.string(),
  cardId: z.string(),
  at: z.string().nullable().default(null),
  gate: z.string().nullable().default(null),
  kind: z.string().nullable().default(null),
});

const StoreMetaSchema = z.object({
  docs: z.record(z.string(), z.record(z.string(), z.unknown())),
});

/** 本文の前後の改行を落とす */
function trimNewlines(text: string): string {
  return text.replace(/^(?:\r?\n)+/, '').replace(/(?:\r?\n)+$/, '');
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

// ------------------------------------------------------------
// 文書 ⇄ Issue・コメント
// ------------------------------------------------------------

/** カードの文書を Issue のタイトルと本文にする */
export function issueFromCard(data: DocumentData): { title: string; body: string } {
  const body = trimNewlines(str(data['body']));
  const marker = encodeMarker('card', {
    id: str(data['id']),
    created: str(data['created']),
    skipGates: Array.isArray(data['skipGates']) ? data['skipGates'] : [],
    branch: typeof data['branch'] === 'string' ? data['branch'] : null,
    pr: typeof data['pr'] === 'number' ? data['pr'] : null,
  });
  return {
    title: str(data['title']),
    body: body === '' ? marker : `${body}\n\n${marker}`,
  };
}

/** 判断の文書をコメントの本文にする。先頭の 1 行は人が読むための見出し */
export function commentFromLog(docId: string, data: DocumentData): string {
  const gate = typeof data['gate'] === 'string' ? data['gate'] : '';
  const kind = typeof data['kind'] === 'string' ? data['kind'] : '';
  const at = typeof data['at'] === 'string' ? data['at'] : '';
  const reason = str(data['reason']).trim();
  const marker = encodeMarker('log', {
    id: docId,
    cardId: str(data['cardId'], cardIdOfDocument(docId)),
    at: at === '' ? null : at,
    gate: gate === '' ? null : gate,
    kind: kind === '' ? null : kind,
  });
  const heading = `**${[gate, kind].filter((part) => part !== '').join(' ') || '判断'}**${at === '' ? '' : ` · ${at}`}`;
  return reason === '' ? `${heading}\n\n${marker}` : `${heading}\n\n${reason}\n\n${marker}`;
}

/** 判断の文書の ID からカード ID を読む（カード ID は `.` を含まない） */
function cardIdOfDocument(docId: string): string {
  const at = docId.indexOf('.');
  return at < 0 ? docId : docId.slice(0, at);
}

const HEADING_LINE = /^\*\*[^\r\n]*(?:\r?\n){0,2}/;

interface RawComment {
  readonly id: number;
  readonly body: string;
  readonly trusted: boolean;
}

interface RawIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly trusted: boolean;
  readonly comments: readonly RawComment[];
}

// ------------------------------------------------------------
// バックエンド
// ------------------------------------------------------------

export interface IssueStoreBackendOptions {
  readonly owner: string;
  readonly repo: string;
  /** `gh api` を走らせる。書き込みは 10 秒を超えうるので、上限を長くしたものを渡す */
  readonly runner: CliRunner;
}

/** 読み込みで分かった Issue とコメントの番号。書き込みで更新先を引く */
interface Index {
  readonly issueOfCard: Map<string, number>;
  readonly commentOfLog: Map<string, number>;
  storeIssue: number | null;
}

const GRAPHQL_ISSUES = `
query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    issues(first: ${ISSUES_PER_PAGE}, after: $cursor, labels: ["${ISSUE_LABEL}"], states: [OPEN, CLOSED], orderBy: {field: CREATED_AT, direction: ASC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        title
        body
        authorAssociation
        comments(first: ${COMMENTS_PER_PAGE}) {
          pageInfo { hasNextPage }
          nodes { databaseId body authorAssociation }
        }
      }
    }
  }
}`;

const GraphqlSchema = z.object({
  data: z.object({
    repository: z.object({
      issues: z.object({
        pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
        nodes: z.array(
          z.object({
            number: z.number(),
            title: z.string(),
            body: z.string().nullable(),
            authorAssociation: z.string(),
            comments: z.object({
              pageInfo: z.object({ hasNextPage: z.boolean() }),
              nodes: z.array(
                z.object({
                  databaseId: z.number(),
                  body: z.string().nullable(),
                  authorAssociation: z.string(),
                })
              ),
            }),
          })
        ),
      }),
    }),
  }),
});

const RestCommentSchema = z.array(
  z.object({
    id: z.number(),
    body: z.string().nullable().optional(),
    author_association: z.string(),
  })
);

export class IssueStoreBackend implements StoreBackend {
  private readonly base: string;
  private index: Index = { issueOfCard: new Map(), commentOfLog: new Map(), storeIssue: null };
  private labelEnsured = false;

  constructor(private readonly options: IssueStoreBackendOptions) {
    this.base = `repos/${options.owner}/${options.repo}`;
  }

  async load(): Promise<Result<Map<string, DocumentData>, StoreError>> {
    const issues = await this.fetchIssues();
    if (isErr(issues)) return issues;

    const docs = new Map<string, DocumentData>();
    const index: Index = { issueOfCard: new Map(), commentOfLog: new Map(), storeIssue: null };
    for (const issue of issues.value) readIssue(issue, docs, index);
    this.index = index;
    return ok(docs);
  }

  async apply(
    writes: ReadonlyMap<string, Written>,
    before: ReadonlyMap<string, DocumentData>
  ): Promise<Result<void, StoreError>> {
    const entries = [...writes];
    const ofCollection = (name: string) =>
      entries.filter(([key]) => parseKey(key).collection === name);

    for (const [key, value] of ofCollection('cards')) {
      const applied = await this.applyCard(parseKey(key).id, value, before.get(key));
      if (isErr(applied)) return applied;
    }
    for (const [key, value] of ofCollection('log')) {
      const applied = await this.applyLog(parseKey(key).id, value, before.get(key));
      if (isErr(applied)) return applied;
    }
    return this.applyStore([...ofCollection('board'), ...ofCollection('order')], before);
  }

  // ------------------------------------------------------------
  // 書き込み
  // ------------------------------------------------------------

  private async applyCard(
    id: string,
    value: Written,
    previous: DocumentData | undefined
  ): Promise<Result<void, StoreError>> {
    const number = this.index.issueOfCard.get(id);
    if (value === DELETED) {
      if (number === undefined) return ok(undefined);
      const closed = await this.write('PATCH', `issues/${number}`, {
        state: 'closed',
        state_reason: 'not_planned',
      });
      if (isErr(closed)) return closed;
      this.index.issueOfCard.delete(id);
      return ok(undefined);
    }

    const issue = issueFromCard(value);
    if (number !== undefined) {
      if (previous !== undefined && sameData(previous, value)) return ok(undefined);
      const patched = await this.write('PATCH', `issues/${number}`, issue);
      return isErr(patched) ? patched : ok(undefined);
    }

    const created = await this.createIssue(issue);
    if (isErr(created)) return created;
    this.index.issueOfCard.set(id, created.value);
    return ok(undefined);
  }

  private async applyLog(
    docId: string,
    value: Written,
    previous: DocumentData | undefined
  ): Promise<Result<void, StoreError>> {
    const commentId = this.index.commentOfLog.get(docId);
    if (value === DELETED) {
      if (commentId === undefined) return ok(undefined);
      const removed = await this.write('DELETE', `issues/comments/${commentId}`);
      if (isErr(removed)) return removed;
      this.index.commentOfLog.delete(docId);
      return ok(undefined);
    }

    const body = commentFromLog(docId, value);
    if (commentId !== undefined) {
      if (previous !== undefined && sameData(previous, value)) return ok(undefined);
      const patched = await this.write('PATCH', `issues/comments/${commentId}`, { body });
      return isErr(patched) ? patched : ok(undefined);
    }

    const cardId = cardIdOfDocument(docId);
    const issue = this.index.issueOfCard.get(cardId);
    if (issue === undefined) {
      return err(apiFailed('判断のコメントを足す', `カード ${cardId} の Issue がありません`));
    }
    const created = await this.write('POST', `issues/${issue}/comments`, { body });
    if (isErr(created)) return created;
    const id = idOf(created.value);
    if (id === null) return err(apiFailed('判断のコメントを足す', '応答に id がありません'));
    this.index.commentOfLog.set(docId, id);
    return ok(undefined);
  }

  /** 形の版と並び順を、専用の Issue の隠しコメントに書く。変わっていなければ書かない */
  private async applyStore(
    changes: readonly (readonly [string, Written])[],
    before: ReadonlyMap<string, DocumentData>
  ): Promise<Result<void, StoreError>> {
    if (changes.length === 0) return ok(undefined);

    const docs: Record<string, DocumentData> = storeDocs(before);
    for (const [key, value] of changes) {
      if (value === DELETED) delete docs[key];
      else docs[key] = value;
    }
    if (sameData(storeDocs(before), docs)) return ok(undefined);

    const body = `${STORE_ISSUE_NOTE}\n\n${encodeMarker('store', { docs })}`;
    const number = this.index.storeIssue;
    if (number !== null) {
      const patched = await this.write('PATCH', `issues/${number}`, {
        title: STORE_ISSUE_TITLE,
        body,
      });
      return isErr(patched) ? patched : ok(undefined);
    }
    const created = await this.createIssue({ title: STORE_ISSUE_TITLE, body });
    if (isErr(created)) return created;
    this.index.storeIssue = created.value;
    return ok(undefined);
  }

  private async createIssue(issue: {
    title: string;
    body: string;
  }): Promise<Result<number, StoreError>> {
    await this.ensureLabel();
    const created = await this.write('POST', 'issues', { ...issue, labels: [ISSUE_LABEL] });
    if (isErr(created)) return created;
    const number = numberOf(created.value);
    return number === null
      ? err(apiFailed('Issue を作る', '応答に number がありません'))
      : ok(number);
  }

  /** ラベルを 1 度だけ作る。既にある・権限が無いときの失敗は読み流す（Issue の作成で自動に作られることもある） */
  private async ensureLabel(): Promise<void> {
    if (this.labelEnsured) return;
    this.labelEnsured = true;
    await this.write('POST', 'labels', {
      name: ISSUE_LABEL,
      color: '0e8a16',
      description: 'ai-board のカード',
    });
  }

  /** REST で書く。本文は標準入力の JSON で渡す（引数に載せない） */
  private async write(
    method: 'POST' | 'PATCH' | 'DELETE',
    endpoint: string,
    body?: unknown
  ): Promise<Result<unknown, StoreError>> {
    const args = ['api', '-X', method, `${this.base}/${endpoint}`];
    const result =
      body === undefined
        ? await this.options.runner.run(GH, args)
        : await this.options.runner.run(GH, [...args, '--input', '-'], {
            input: JSON.stringify(body),
          });
    if (isErr(result))
      return err(apiFailed(`${method} ${endpoint}`, describeCliErrorWithStatus(result.error)));
    const text = result.value.trim();
    if (text === '') return ok(null);
    const parsed = parseJson<unknown>(GH, text);
    return isErr(parsed)
      ? err(apiFailed(`${method} ${endpoint}`, describeCliErrorWithStatus(parsed.error)))
      : ok(parsed.value);
  }

  // ------------------------------------------------------------
  // 読み込み
  // ------------------------------------------------------------

  private async fetchIssues(): Promise<Result<RawIssue[], StoreError>> {
    const issues: RawIssue[] = [];
    let cursor: string | null = null;
    for (;;) {
      const args = [
        'api',
        'graphql',
        '-f',
        `query=${GRAPHQL_ISSUES}`,
        '-f',
        `owner=${this.options.owner}`,
        '-f',
        `repo=${this.options.repo}`,
        ...(cursor === null ? [] : ['-f', `cursor=${cursor}`]),
      ];
      const ran = await this.options.runner.run(GH, args);
      if (isErr(ran)) return err(apiFailed('Issue を読む', describeCliErrorWithStatus(ran.error)));
      const json = parseJson<unknown>(GH, ran.value);
      if (isErr(json))
        return err(apiFailed('Issue を読む', describeCliErrorWithStatus(json.error)));
      const parsed = GraphqlSchema.safeParse(json.value);
      if (!parsed.success) {
        return err(apiFailed('Issue を読む', 'GitHub の応答の形が想定と違います'));
      }

      const page = parsed.data.data.repository.issues;
      for (const node of page.nodes) {
        let comments: RawComment[] = node.comments.nodes.map((comment) => ({
          id: comment.databaseId,
          body: comment.body ?? '',
          trusted: TRUSTED_ASSOCIATIONS.has(comment.authorAssociation),
        }));
        if (node.comments.pageInfo.hasNextPage) {
          const all = await this.fetchComments(node.number);
          if (isErr(all)) return all;
          comments = all.value;
        }
        issues.push({
          number: node.number,
          title: node.title,
          body: node.body ?? '',
          trusted: TRUSTED_ASSOCIATIONS.has(node.authorAssociation),
          comments,
        });
      }
      if (!page.pageInfo.hasNextPage || page.pageInfo.endCursor === null) return ok(issues);
      cursor = page.pageInfo.endCursor;
    }
  }

  /** コメントが 100 件を超えた Issue のコメントを、REST で全ページ読む */
  private async fetchComments(issue: number): Promise<Result<RawComment[], StoreError>> {
    const comments: RawComment[] = [];
    for (let page = 1; ; page++) {
      const endpoint = `issues/${issue}/comments?per_page=${COMMENTS_PER_PAGE}&page=${page}`;
      const ran = await this.options.runner.run(GH, ['api', `${this.base}/${endpoint}`]);
      if (isErr(ran))
        return err(apiFailed('コメントを読む', describeCliErrorWithStatus(ran.error)));
      const json = parseJson<unknown>(GH, ran.value);
      if (isErr(json))
        return err(apiFailed('コメントを読む', describeCliErrorWithStatus(json.error)));
      const parsed = RestCommentSchema.safeParse(json.value);
      if (!parsed.success)
        return err(apiFailed('コメントを読む', 'GitHub の応答の形が想定と違います'));
      for (const comment of parsed.data) {
        comments.push({
          id: comment.id,
          body: comment.body ?? '',
          trusted: TRUSTED_ASSOCIATIONS.has(comment.author_association),
        });
      }
      if (parsed.data.length < COMMENTS_PER_PAGE) return ok(comments);
    }
  }
}

/** Issue 1 件を文書にして `docs` と `index` に足す。読めない Issue は警告して読み飛ばす（1 枚でボード全体を止めない） */
function readIssue(issue: RawIssue, docs: Map<string, DocumentData>, index: Index): void {
  const where = `#${issue.number}`;
  if (!issue.trusted) {
    console.warn(
      `[ai-board] Issue ${where} を読み飛ばしました: 作者が OWNER / MEMBER / COLLABORATOR ではありません`
    );
    return;
  }
  const marked = splitMarker(issue.body);
  if (marked === null) {
    console.warn(`[ai-board] Issue ${where} を読み飛ばしました: 末尾の隠しコメントがありません`);
    return;
  }

  if (marked.kind === 'store') {
    const meta = StoreMetaSchema.safeParse(marked.data);
    if (!meta.success || index.storeIssue !== null) {
      console.warn(
        `[ai-board] Issue ${where} を読み飛ばしました: 置き場所の Issue として読めないか、重複しています`
      );
      return;
    }
    index.storeIssue = issue.number;
    for (const [key, data] of Object.entries(meta.data.docs)) docs.set(key, data as DocumentData);
    return;
  }
  if (marked.kind !== 'card') return;

  const meta = CardMetaSchema.safeParse(marked.data);
  if (!meta.success || !CardIdSchema.safeParse(meta.data.id).success) {
    console.warn(`[ai-board] Issue ${where} を読み飛ばしました: カードの隠しコメントが不正です`);
    return;
  }
  const id = meta.data.id;
  if (index.issueOfCard.has(id)) {
    console.warn(
      `[ai-board] Issue ${where} を読み飛ばしました: カード ${id} は先の Issue にあります`
    );
    return;
  }

  index.issueOfCard.set(id, issue.number);
  docs.set(keyOf('cards', id), {
    id,
    title: issue.title,
    created: meta.data.created,
    skipGates: meta.data.skipGates,
    branch: meta.data.branch,
    pr: meta.data.pr,
    body: trimNewlines(marked.rest),
  });

  for (const comment of issue.comments) readComment(id, issue.number, comment, docs, index);
}

function readComment(
  cardId: string,
  issue: number,
  comment: RawComment,
  docs: Map<string, DocumentData>,
  index: Index
): void {
  const marked = splitMarker(comment.body);
  if (marked === null || marked.kind !== 'log') return; // 人の普通のコメント
  if (!comment.trusted) {
    console.warn(
      `[ai-board] Issue #${issue} のコメントを読み飛ばしました: 作者が OWNER / MEMBER / COLLABORATOR ではありません`
    );
    return;
  }
  const meta = LogMetaSchema.safeParse(marked.data);
  // 別のカードの判断を名乗るコメントは読まない
  if (
    !meta.success ||
    !isValidDocumentId(meta.data.id) ||
    !meta.data.id.startsWith(`${cardId}.`) ||
    meta.data.cardId !== cardId
  ) {
    console.warn(
      `[ai-board] Issue #${issue} のコメントを読み飛ばしました: 判断の隠しコメントが不正です`
    );
    return;
  }
  if (index.commentOfLog.has(meta.data.id)) return;

  index.commentOfLog.set(meta.data.id, comment.id);
  docs.set(keyOf('log', meta.data.id), {
    cardId,
    at: meta.data.at,
    gate: meta.data.gate,
    kind: meta.data.kind,
    reason: marked.rest.replace(HEADING_LINE, '').trim(),
  });
}

// ------------------------------------------------------------
// ヘルパー
// ------------------------------------------------------------

function storeDocs(before: ReadonlyMap<string, DocumentData>): Record<string, DocumentData> {
  const docs: Record<string, DocumentData> = {};
  for (const [key, data] of before) {
    const { collection } = parseKey(key);
    if (collection === 'board' || collection === 'order') docs[key] = data;
  }
  return docs;
}

/** 中身が同じか。キーの順は問わない */
function sameData(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v
  );
}

function numberOf(value: unknown): number | null {
  const number = (value as { number?: unknown } | null)?.number;
  return typeof number === 'number' ? number : null;
}

function idOf(value: unknown): number | null {
  const id = (value as { id?: unknown } | null)?.id;
  return typeof id === 'number' ? id : null;
}

function apiFailed(operation: string, message: string): StoreError {
  return { type: 'StoreApiFailed', operation, message };
}

// ------------------------------------------------------------
// 組み立て
// ------------------------------------------------------------

/** GitHub の Issue の置き場所（`DocumentStore`）。手元の文書・ロックは `localDir` に置く */
export function createIssueDocumentStore(options: {
  readonly owner: string;
  readonly repo: string;
  readonly runner: CliRunner;
  readonly localDir: string;
  readonly lockOptions?: LockOptions;
}): BackedDocumentStore {
  return new BackedDocumentStore({
    backend: new IssueStoreBackend({
      owner: options.owner,
      repo: options.repo,
      runner: options.runner,
    }),
    localDir: options.localDir,
    localCollections: LOCAL_COLLECTIONS,
    ...(options.lockOptions === undefined ? {} : { lockOptions: options.lockOptions }),
  });
}
