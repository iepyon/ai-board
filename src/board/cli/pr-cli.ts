import { promises as fs } from 'node:fs';
import type { CardCliIo } from '../../cards/cli/card-cli.js';
import type { ForgeConfig } from '../../shared/config.js';
import type { MergeRequestIid } from '../../shared/schemas/common.js';
import { isErr } from '../../shared/result.js';
import {
  describeCliError,
  type CliError,
  type CliRunner,
} from '../../infrastructure/cli-runner.js';
import { toMergeRequestIid } from '../services/forge-client.js';
import {
  GhPullRequestClient,
  type PullRequestComment,
  type PullRequestView,
} from '../services/github-client.js';
import type { MrLifecycleState } from '../models/mr-state.js';

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
export const PR_USAGE = `使い方: ai-board pr <command> [--root <path>]

Commands:
  create --head <branch> --title <t> --body-file <f> [--base <branch>] [--draft]
                           PR を作り、番号と URL を出す（--base の既定はリポジトリの既定のブランチ）
  view <n> [--comments | --body]
                           PR の題・状態・ブランチ・本文を出す。--comments でコメントも出す。
                           --body は本文だけをそのまま出す（edit で書き戻す本文を作るとき）
  edit <n> --body-file <f> PR の本文をファイルの内容に差し替える
  comment <n> --body-file <f>
                           PR にファイルの内容をコメントとして書く
  diff <n>                 PR の差分を unified diff で出す
  ready <n>                PR を Ready にする（gh pr ready を試し、失敗したら ccr/ready_for_review を試す）
`;

export interface PrCliDependencies {
  /** `config.yaml` の GitHub の接続設定。無ければ null */
  readonly forge: ForgeConfig | null;
  readonly runner: CliRunner;
}

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
  readonly run: (args: ParsedArgs, client: GhPullRequestClient, io: PrCliIo) => Promise<number>;
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

  return spec.run(parsed, new GhPullRequestClient(deps.forge, deps.runner), io);
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
  const iid = requireIid(args, io);
  if (iid === null) return 1;

  const withComments = args.flags.has('--comments');
  const bodyOnly = args.flags.has('--body');
  if (withComments && bodyOnly) {
    io.stderr('--comments と --body は同時に指定できません\n');
    return 1;
  }

  const pr = await client.view(iid);
  if (isErr(pr)) return fail(io, `PR #${iid} を読めませんでした`, pr.error);

  if (bodyOnly) {
    io.stdout(withTrailingNewline(pr.value.body));
    return 0;
  }

  let text = formatPullRequest(pr.value);

  if (withComments) {
    const comments = await client.comments(iid);
    if (isErr(comments)) return fail(io, `PR #${iid} のコメントを読めませんでした`, comments.error);
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
  const iid = requireIid(args, io);
  if (iid === null) return 1;

  const body = await readBodyFile(args, io);
  if (body === null) return 1;

  const edited = await client.editBody(iid, body);
  if (isErr(edited)) return fail(io, `PR #${iid} の本文を書き換えられませんでした`, edited.error);

  io.stdout(`${edited.value}\n`);
  return 0;
}

async function runComment(
  args: ParsedArgs,
  client: GhPullRequestClient,
  io: PrCliIo
): Promise<number> {
  const iid = requireIid(args, io);
  if (iid === null) return 1;

  const body = await readBodyFile(args, io);
  if (body === null) return 1;

  const created = await client.comment(iid, body);
  if (isErr(created)) return fail(io, `PR #${iid} にコメントを書けませんでした`, created.error);

  io.stdout(`${created.value}\n`);
  return 0;
}

async function runDiff(
  args: ParsedArgs,
  client: GhPullRequestClient,
  io: PrCliIo
): Promise<number> {
  const iid = requireIid(args, io);
  if (iid === null) return 1;

  const diff = await client.diff(iid);
  if (isErr(diff)) return fail(io, `PR #${iid} の差分を読めませんでした`, diff.error);

  io.stdout(diff.value);
  return 0;
}

async function runReady(
  args: ParsedArgs,
  client: GhPullRequestClient,
  io: PrCliIo
): Promise<number> {
  const iid = requireIid(args, io);
  if (iid === null) return 1;

  const ready = await client.ready(iid);
  if (isErr(ready)) {
    io.stderr(
      `PR #${iid} を Ready にできませんでした\n` +
        `  gh pr ready: ${describePrError(ready.error.gh)}\n` +
        `  ccr/ready_for_review: ${describePrError(ready.error.ccr)}\n`
    );
    return 1;
  }

  const route = ready.value === 'gh' ? 'gh pr ready' : 'ccr/ready_for_review';
  io.stdout(`PR #${iid} を Ready にしました（${route}）\n`);
  return 0;
}

// ============================================================
// ヘルパー
// ============================================================

/** 位置引数の PR 番号を 1 つだけ取り出す。正の整数でなければ null */
function requireIid(args: ParsedArgs, io: PrCliIo): MergeRequestIid | null {
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

  return toMergeRequestIid(Number(raw));
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

const STATE_LABELS: Readonly<Record<MrLifecycleState, string>> = {
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
