import { promises as fs } from 'node:fs';
import type { CardCliIo } from '../../cards/cli/card-cli.js';
import type { ForgeConfig } from '../../shared/config.js';
import type { PullRequestNumber } from '../../shared/schemas/common.js';
import { isErr } from '../../shared/result.js';
import {
  describeCliError,
  type CliError,
  type CliRunner,
} from '../../infrastructure/cli-runner.js';
import { toPullRequestNumber } from '../services/forge-client.js';
import {
  GhPullRequestClient,
  type PullRequestChecks,
  type PullRequestComment,
  type PullRequestView,
  withClaudeCodeFooter,
} from '../services/github-client.js';
import type { PrLifecycleState } from '../models/pr-state.js';
import type { CheckRow, ChecksSummary, ChecksVerdict } from '../services/pr-checks.js';

// ============================================================
// ai-board pr — 手順書の `gh pr` を置き換える CLI
// ============================================================

/**
 * クラウドのセッションでは GraphQL が 403 になり `gh pr` が動かない。
 * 手元でもクラウドでも同じ手順書で動くよう、PR の読み書きを REST（`gh api`）で行う。
 *
 * 本文は `--body-file` のファイルから読み、引数には載せない（`gh api --input` で渡す）。
 * カードには書かないので、書き込み境界は変わらない。
 */
/** `checks --wait` の引き直しの間隔・上限の既定・チェックの登録を待つ猶予（秒） */
export const CHECKS_INTERVAL_SECONDS = 15;
export const CHECKS_TIMEOUT_SECONDS = 900;
export const CHECKS_GRACE_SECONDS = 120;

export const PR_USAGE = `使い方: ai-board pr <command> [--root <path>]

Commands:
  create --head <branch> --title <t> --body-file <f> [--base <branch>] [--draft]
                           PR を作り、番号と URL を出す（--base の既定はリポジトリの既定のブランチ）
  view <n> [--comments | --body]
                           PR の題・状態・ブランチ・本文を出す。--comments でコメントも出す。
                           --body は本文だけをそのまま出す（edit で書き戻す本文を作るとき）
  edit <n> --body-file <f> PR の本文をファイルの内容に差し替える
  comment <n> --body-file <f>
                           PR にファイルの内容をコメントとして書く。Claude Code のフッターが無ければ末尾に足す
                           （フッターの付いたコメントは AI の返信と読み、人の指摘に数えない）
  diff <n>                 PR の差分を unified diff で出す
  ready <n>                PR を Ready にする（gh pr ready を試し、失敗したら ccr/ready_for_review を試す）
  checks <n> [--sha <sha>] [--wait [--timeout <秒>]] [--json]
                           PR の最新コミット（--sha ならそのコミット。7 桁以上の短いハッシュも可）のチェック（check-runs と status）をまとめて出す。
                           --sha のコミットがまだ PR の head でなければ、走っているとして扱う。
                           終了コードは passed / none が 0、failed が 1、pending が 2、読めなかったら 3。
                           --wait は走っている間（push の直後でチェックがまだ無い間は ${CHECKS_GRACE_SECONDS} 秒まで）
                           ${CHECKS_INTERVAL_SECONDS} 秒おきに引き直して待つ（--timeout の既定は ${CHECKS_TIMEOUT_SECONDS} 秒）
`;

export interface PrCliDependencies {
  /** `config.yaml` の GitHub の接続設定。無ければ null */
  readonly forge: ForgeConfig | null;
  readonly runner: CliRunner;
  /** `checks --wait` が使う時計。テストで差し替える。省けば本物の時計と `setTimeout` */
  readonly clock?: WaitClock;
}

/** `checks --wait` の待ちに使う時計 */
export interface WaitClock {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

const realClock: WaitClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

type PrCliIo = Pick<CardCliIo, 'stdout' | 'stderr'>;

interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

interface CommandSpec {
  /** 値を取るフラグ */
  readonly values: readonly string[];
  /** 値を取らないフラグ */
  readonly switches: readonly string[];
  readonly run: (
    args: ParsedArgs,
    client: GhPullRequestClient,
    io: PrCliIo,
    clock: WaitClock
  ) => Promise<number>;
}

const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  create: {
    values: ['--head', '--base', '--title', '--body-file'],
    switches: ['--draft'],
    run: runCreate,
  },
  view: { values: [], switches: ['--comments', '--body'], run: runView },
  edit: { values: ['--body-file'], switches: [], run: runEdit },
  comment: { values: ['--body-file'], switches: [], run: runComment },
  diff: { values: [], switches: [], run: runDiff },
  ready: { values: [], switches: [], run: runReady },
  checks: { values: ['--timeout', '--sha'], switches: ['--wait', '--json'], run: runChecks },
};

/** `ai-board pr` のコマンドの名前か */
export function isPrCommand(name: string | undefined): boolean {
  return name !== undefined && Object.hasOwn(COMMANDS, name);
}

/** `ai-board pr <command>` を実行し、終了コードを返す */
export async function runPrCli(
  argv: readonly string[],
  deps: PrCliDependencies,
  io: PrCliIo
): Promise<number> {
  const [command, ...rest] = argv;
  const spec = isPrCommand(command) ? COMMANDS[command ?? ''] : undefined;

  const wantsHelp = argv.includes('--help') || argv.includes('-h');
  if (spec === undefined || wantsHelp) {
    io.stderr(PR_USAGE);
    return command === undefined || wantsHelp ? 0 : 1;
  }

  const parsed = parsePrArgs(rest, spec);
  if (typeof parsed === 'string') {
    io.stderr(`${parsed}\n`);
    return 1;
  }

  if (deps.forge === null) {
    io.stderr('config.yaml に github: の設定がありません。PR を読み書きする先が決まりません\n');
    return 1;
  }

  return spec.run(
    parsed,
    new GhPullRequestClient(deps.forge, deps.runner),
    io,
    deps.clock ?? realClock
  );
}

/** 引数を位置引数とフラグに分ける。コマンドが受け付けないフラグは打ち間違いとして拒む */
function parsePrArgs(argv: readonly string[], spec: CommandSpec): ParsedArgs | string {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';

    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    if (spec.switches.includes(arg)) {
      flags.set(arg, true);
      continue;
    }

    if (!spec.values.includes(arg)) {
      return `不明なオプションです: ${arg}`;
    }

    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      return `${arg} には値を指定してください`;
    }
    flags.set(arg, value);
    i += 1;
  }

  return { positionals, flags };
}

// ============================================================
// サブコマンド
// ============================================================

async function runCreate(
  args: ParsedArgs,
  client: GhPullRequestClient,
  io: PrCliIo
): Promise<number> {
  if (args.positionals.length > 0) {
    io.stderr(`余分な引数があります: ${args.positionals.join(' ')}\n`);
    return 1;
  }

  const head = requireValue(args, '--head', io);
  const title = requireValue(args, '--title', io);
  if (head === null || title === null) return 1;

  const body = await readBodyFile(args, io);
  if (body === null) return 1;

  const base = args.flags.get('--base');
  const created = await client.create({
    head,
    base: typeof base === 'string' ? base : null,
    title,
    body,
    draft: args.flags.has('--draft'),
  });
  if (isErr(created)) return fail(io, 'PR を作れませんでした', created.error);

  io.stdout(`#${created.value.number} ${created.value.url}\n`);
  return 0;
}

async function runView(
  args: ParsedArgs,
  client: GhPullRequestClient,
  io: PrCliIo
): Promise<number> {
  const number = requireNumber(args, io);
  if (number === null) return 1;

  const withComments = args.flags.has('--comments');
  const bodyOnly = args.flags.has('--body');
  if (withComments && bodyOnly) {
    io.stderr('--comments と --body は同時に指定できません\n');
    return 1;
  }

  const pr = await client.view(number);
  if (isErr(pr)) return fail(io, `PR #${number} を読めませんでした`, pr.error);

  if (bodyOnly) {
    io.stdout(withTrailingNewline(pr.value.body));
    return 0;
  }

  let text = formatPullRequest(pr.value);

  if (withComments) {
    const comments = await client.comments(number);
    if (isErr(comments))
      return fail(io, `PR #${number} のコメントを読めませんでした`, comments.error);
    text += formatComments(comments.value);
  }

  io.stdout(text);
  return 0;
}

async function runEdit(
  args: ParsedArgs,
  client: GhPullRequestClient,
  io: PrCliIo
): Promise<number> {
  const number = requireNumber(args, io);
  if (number === null) return 1;

  const body = await readBodyFile(args, io);
  if (body === null) return 1;

  const edited = await client.editBody(number, body);
  if (isErr(edited))
    return fail(io, `PR #${number} の本文を書き換えられませんでした`, edited.error);

  io.stdout(`${edited.value}\n`);
  return 0;
}

async function runComment(
  args: ParsedArgs,
  client: GhPullRequestClient,
  io: PrCliIo
): Promise<number> {
  const number = requireNumber(args, io);
  if (number === null) return 1;

  const body = await readBodyFile(args, io);
  if (body === null) return 1;

  // AI が人のアカウントで書くので、フッターで人の指摘と見分ける（`isAiComment`）
  const created = await client.comment(number, withClaudeCodeFooter(body));
  if (isErr(created)) return fail(io, `PR #${number} にコメントを書けませんでした`, created.error);

  io.stdout(`${created.value}\n`);
  return 0;
}

async function runDiff(
  args: ParsedArgs,
  client: GhPullRequestClient,
  io: PrCliIo
): Promise<number> {
  const number = requireNumber(args, io);
  if (number === null) return 1;

  const diff = await client.diff(number);
  if (isErr(diff)) return fail(io, `PR #${number} の差分を読めませんでした`, diff.error);

  io.stdout(diff.value);
  return 0;
}

async function runReady(
  args: ParsedArgs,
  client: GhPullRequestClient,
  io: PrCliIo
): Promise<number> {
  const number = requireNumber(args, io);
  if (number === null) return 1;

  const ready = await client.ready(number);
  if (isErr(ready)) {
    io.stderr(
      `PR #${number} を Ready にできませんでした\n` +
        `  gh pr ready: ${describePrError(ready.error.gh)}\n` +
        `  ccr/ready_for_review: ${describePrError(ready.error.ccr)}\n`
    );
    return 1;
  }

  const route = ready.value === 'gh' ? 'gh pr ready' : 'ccr/ready_for_review';
  io.stdout(`PR #${number} を Ready にしました（${route}）\n`);
  return 0;
}

/**
 * チェックの判定ごとの終了コード。passed / none は 0、failed は 1、pending（待ち切れなかったときも）は 2。
 * PR やチェックを読めなかったときは `CHECKS_UNREADABLE_EXIT`（3）。締めの段は 1 を「CI が落ちた、直す」と読むので、読めなかったことと分ける
 */
const CHECKS_EXIT: Readonly<Record<ChecksVerdict, number>> = {
  passed: 0,
  none: 0,
  failed: 1,
  pending: 2,
};

const CHECKS_UNREADABLE_EXIT = 3;

const OUTCOME_LABELS: Readonly<Record<CheckRow['outcome'], string>> = {
  passed: '通った',
  failed: '落ちた',
  pending: '走っている',
};

/**
 * PR の最新コミットのチェックをまとめて出す。
 *
 * `--wait` は、走っている間と、push の直後でチェックがまだ 1 つも無い間（猶予まで）、CLI の中で間隔を置いて引き直す。
 * 手順書のシェルで `sleep` しないで済むようにするため（環境によって前景の `sleep` が止められる）。
 */
async function runChecks(
  args: ParsedArgs,
  client: GhPullRequestClient,
  io: PrCliIo,
  clock: WaitClock
): Promise<number> {
  const number = requireNumber(args, io);
  const options = number === null ? null : parseChecksOptions(args, io);
  if (number === null || options === null) return 1;

  const json = args.flags.has('--json');
  const wait = { ...options, startedAt: clock.now(), watchingSince: null as number | null };
  for (;;) {
    const fetched = await client.checks(number, options.sha);
    if (isErr(fetched)) {
      io.stderr(
        `PR #${number} のチェックを読めませんでした（${describePrError(fetched.error)}）\n`
      );
      return CHECKS_UNREADABLE_EXIT;
    }

    const now = clock.now();
    // チェックの登録を待つ猶予は、見るコミットが PR の head になった時から数える
    if (fetched.value.summary !== null) wait.watchingSince ??= now;

    const step = nextCheckStep(fetched.value, wait, now);
    if (step.kind === 'report') {
      return reportChecks(number, step.summary, json, step.timedOut, io, fetched.value.headSha);
    }
    await clock.sleep(CHECKS_INTERVAL_SECONDS * 1000);
  }
}

type CheckStep =
  | { readonly kind: 'report'; readonly summary: ChecksSummary; readonly timedOut: boolean }
  | { readonly kind: 'sleep' };

/**
 * 引いた結果から、出して終えるか、もう 1 回待つかを決める。
 *
 * - 待たない（`--wait` なし）なら、今の結果を出す。見るコミットがまだ head でなければ走っているとして出す
 * - 待ち終えてよい（`isSettled`）なら出す
 * - もう 1 回待つと上限を超えるなら、走っているとして出す（猶予の間や head が動く前でも、チェックが無いとは言わない）
 */
function nextCheckStep(
  fetched: PullRequestChecks,
  wait: {
    readonly wait: boolean;
    readonly timeoutSeconds: number;
    readonly sha: string | null;
    readonly startedAt: number;
    readonly watchingSince: number | null;
  },
  now: number
): CheckStep {
  const { summary } = fetched;
  if (summary !== null && (!wait.wait || isSettled(summary, wait.watchingSince, now))) {
    return { kind: 'report', summary, timedOut: false };
  }

  const exceeded =
    now - wait.startedAt + CHECKS_INTERVAL_SECONDS * 1000 > wait.timeoutSeconds * 1000;
  if (!wait.wait || exceeded) {
    const sha = wait.sha ?? fetched.headSha;
    return { kind: 'report', summary: pendingSummary(summary, sha), timedOut: wait.wait };
  }
  return { kind: 'sleep' };
}

/**
 * 待ち終えてよいか。走っておらず、チェックが無いなら登録を待つ猶予
 * （見るコミットが head になってから `CHECKS_GRACE_SECONDS`）を過ぎている
 */
function isSettled(summary: ChecksSummary, watchingSince: number | null, now: number): boolean {
  if (summary.verdict === 'pending') return false;
  if (summary.verdict !== 'none') return true;
  return watchingSince !== null && now - watchingSince >= CHECKS_GRACE_SECONDS * 1000;
}

/** まだ見られていない（head が動いていない・チェックの登録待ち）ときの、走っているとしてのまとめ */
function pendingSummary(summary: ChecksSummary | null, sha: string): ChecksSummary {
  return summary === null
    ? { sha, verdict: 'pending', rows: [], statusUnreadable: null }
    : { ...summary, verdict: 'pending' };
}

/** `--wait` と `--timeout` を読む。誤りなら理由を出して null */
function parseChecksOptions(
  args: ParsedArgs,
  io: PrCliIo
): { readonly wait: boolean; readonly timeoutSeconds: number; readonly sha: string | null } | null {
  const wait = args.flags.has('--wait');
  const timeoutFlag = args.flags.get('--timeout');
  if (timeoutFlag !== undefined && !wait) {
    io.stderr('--timeout は --wait と一緒に指定してください\n');
    return null;
  }

  const timeoutSeconds =
    typeof timeoutFlag === 'string' ? Number(timeoutFlag) : CHECKS_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1) {
    io.stderr(`--timeout は 1 以上の整数（秒）で指定してください: ${String(timeoutFlag)}\n`);
    return null;
  }

  const shaFlag = args.flags.get('--sha');
  if (typeof shaFlag === 'string' && !/^[0-9a-f]{7,40}$/.test(shaFlag)) {
    io.stderr(`--sha にはコミットのハッシュ（16 進）を指定してください: ${shaFlag}\n`);
    return null;
  }

  return { wait, timeoutSeconds, sha: typeof shaFlag === 'string' ? shaFlag : null };
}

function reportChecks(
  number: PullRequestNumber,
  summary: ChecksSummary,
  json: boolean,
  timedOut: boolean,
  io: PrCliIo,
  headSha: string = summary.sha
): number {
  if (json) {
    io.stdout(`${JSON.stringify({ ...summary, timedOut }, null, 2)}\n`);
    return CHECKS_EXIT[summary.verdict];
  }

  const lines = [
    `PR #${number} の最新コミット ${summary.sha.slice(0, 7)} のチェック: ${summary.verdict}` +
      (timedOut ? '（待ち切れませんでした）' : ''),
  ];
  if (headSha !== summary.sha) {
    lines.push(`  PR の head はまだ ${headSha.slice(0, 7)} で、このコミットになっていません`);
  } else if (summary.rows.length === 0) {
    lines.push(timedOut ? '  チェックはまだ登録されていません' : '  チェックはありません');
  }
  if (summary.statusUnreadable !== null) {
    lines.push(
      `  status（Commit Status API）は読めませんでした（${summary.statusUnreadable}）。外部の CI の結果は入っていません`
    );
  }
  for (const row of summary.rows) {
    const source = row.source === 'status' ? '（status）' : '';
    lines.push(
      `  ${OUTCOME_LABELS[row.outcome]}  ${row.name}${source}  ${row.detail}${row.url === null ? '' : `  ${row.url}`}`
    );
  }
  io.stdout(`${lines.join('\n')}\n`);
  return CHECKS_EXIT[summary.verdict];
}

// ============================================================
// ヘルパー
// ============================================================

/** 位置引数の PR 番号を 1 つだけ取り出す。正の整数でなければ null */
function requireNumber(args: ParsedArgs, io: PrCliIo): PullRequestNumber | null {
  const [raw, ...extra] = args.positionals;

  if (raw === undefined) {
    io.stderr('PR の番号を指定してください\n');
    return null;
  }
  if (extra.length > 0) {
    io.stderr(`余分な引数があります: ${extra.join(' ')}\n`);
    return null;
  }
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    io.stderr(`PR の番号は正の整数で指定してください: ${raw}\n`);
    return null;
  }

  return toPullRequestNumber(Number(raw));
}

function requireValue(args: ParsedArgs, flag: string, io: PrCliIo): string | null {
  const value = args.flags.get(flag);

  if (typeof value !== 'string' || value.trim() === '') {
    io.stderr(`${flag} を指定してください\n`);
    return null;
  }

  return value;
}

/** `--body-file` のファイルを読む。読めなければ理由を出して null */
async function readBodyFile(args: ParsedArgs, io: PrCliIo): Promise<string | null> {
  const file = requireValue(args, '--body-file', io);
  if (file === null) return null;

  try {
    return await fs.readFile(file, 'utf-8');
  } catch {
    io.stderr(`--body-file のファイルを読めません: ${file}\n`);
    return null;
  }
}

function fail(io: PrCliIo, what: string, error: CliError): number {
  io.stderr(`${what}（${describePrError(error)}）\n`);
  return 1;
}

/**
 * 失敗の 1 行。HTTP のステータスが分かれば添える。
 * stderr の本文は資格情報が混じりうるので載せない（`cli-runner.ts` の方針のまま）。
 */
export function describePrError(error: CliError): string {
  const message = describeCliError(error);

  return error.type === 'Failed' && error.httpStatus !== null
    ? `${message}（HTTP ${error.httpStatus}）`
    : message;
}

const STATE_LABELS: Readonly<Record<PrLifecycleState, string>> = {
  opened: '開いている',
  merged: 'マージ済み',
  closed: '閉じている',
  locked: 'ロックされている',
};

/** `view` の頭の数行と本文 */
export function formatPullRequest(pr: PullRequestView): string {
  const state = `${STATE_LABELS[pr.state]}${pr.draft ? '（Draft）' : ''}`;

  return (
    `#${pr.number} ${pr.title}\n` +
    `状態: ${state}\n` +
    `ブランチ: ${pr.head} → ${pr.base}\n` +
    `作成者: ${pr.author ?? '不明'}\n` +
    `URL: ${pr.url}\n` +
    `\n${withTrailingNewline(pr.body)}`
  );
}

/** `view --comments` のコメントの節。時刻の順に並んだものを受け取る */
export function formatComments(comments: readonly PullRequestComment[]): string {
  const entries = comments.map((comment) => {
    const where =
      comment.path === null
        ? ''
        : `  ${comment.path}${comment.line === null ? '' : `:${comment.line}`}`;

    return (
      `\n### ${comment.author ?? '不明'}  ${comment.createdAt}${where}\n` +
      `${comment.url}\n\n${withTrailingNewline(comment.body)}`
    );
  });

  return `\n## コメント（${comments.length} 件）\n${entries.join('')}`;
}

function withTrailingNewline(text: string): string {
  return text === '' || text.endsWith('\n') ? text : `${text}\n`;
}
