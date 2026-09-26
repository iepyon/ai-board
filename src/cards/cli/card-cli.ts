import { isDeepStrictEqual } from 'node:util';
import { CardIdSchema, type CardId } from '../../shared/schemas/common.js';
import type { CardDependencies } from '../composition.js';
import type { Card } from '../models/card.js';
import type { CreateCardError, UpdateCardError } from '../errors/card-errors.js';
import { readCardFiles, serializeCard } from '../repositories/card-markdown.js';
import { parseReviewLog } from '../services/review-log.js';

// ============================================================
// ai-board card — エージェントがカードに書くための CLI
// ============================================================

/**
 * エージェントに許す操作だけを並べる。
 *
 * `startedAt`・`rank`・`skipGates` の書き換えと、承認 / 否決 / 中止の追記は
 * 人の判断であり、ここには入口を置かない（UI と HTTP API からだけ行える）。
 * 本文の差し替えも、`## レビュー` のエントリを変えるものは拒否する。
 */
export const CARD_USAGE = `使い方: ai-board card <command> [--root <path>]

Commands:
  list                     カードの一覧を JSON で出す（本文を除く。並び順は rank 順）
  show <id>                カードを Markdown（frontmatter + 本文）で出す
  create --title <t> [--id <id>]
                           アイデアカードを作る。本文は標準入力から読む（任意）
  body <id>                本文を標準入力の内容に差し替える
                           （## レビュー のエントリが変わる差し替えは拒否する）
  branch <id> <name>       ブランチを紐付ける。--clear で外す
  submit <id> [--resubmit] [--reason <text>]
                           ## レビュー に plan 提出（--resubmit で再提出）を追記する
`;

export interface CardCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** 標準入力を最後まで読む。端末から起動されて入力が無ければ null */
  readonly readStdin: () => Promise<string | null>;
  readonly now: () => Date;
}

/** 引数の解析結果。位置引数とフラグを分けておく */
interface ParsedArgs {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, string | true>;
}

type Handler = (args: ParsedArgs, deps: CardDependencies, io: CardCliIo) => Promise<number>;

const VALUE_FLAGS = new Set(['--title', '--id', '--reason', '--from']);

const HANDLERS: Readonly<Record<string, Handler>> = {
  list: runList,
  show: runShow,
  create: runCreate,
  body: runBody,
  branch: runBranch,
  submit: runSubmit,
};

/** `ai-board card <command>` を実行し、終了コードを返す */
export async function runCardCli(
  argv: readonly string[],
  deps: CardDependencies,
  io: CardCliIo
): Promise<number> {
  const [command, ...rest] = argv;
  const handler = command === undefined ? undefined : HANDLERS[command];

  if (handler === undefined) {
    io.stderr(CARD_USAGE);
    return command === undefined || command === '--help' || command === '-h' ? 0 : 1;
  }

  const parsed = parseCommandArgs(rest);
  if (typeof parsed === 'string') {
    io.stderr(`${parsed}\n`);
    return 1;
  }

  return handler(parsed, deps, io);
}

/** `ai-board import`。移行前の Markdown カードを DB に取り込む。既存の ID は上書きしない */
export async function runImport(
  cardsDir: string,
  deps: CardDependencies,
  io: CardCliIo
): Promise<number> {
  const cards = await readCardFiles(cardsDir);
  let imported = 0;

  for (const card of cards) {
    if (await deps.cardRepository.create(card)) {
      imported += 1;
    } else {
      io.stderr(`既に DB にあるため読み飛ばしました: ${card.id}\n`);
    }
  }

  io.stdout(`${imported} 件のカードを取り込みました（${cardsDir}）\n`);
  return 0;
}

/** 引数を位置引数とフラグに分ける。`--root` は呼び出し側で取り除いてある */
export function parseCommandArgs(argv: readonly string[]): ParsedArgs | string {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';

    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }

    if (!VALUE_FLAGS.has(arg)) {
      flags.set(arg, true);
      continue;
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

async function runList(_args: ParsedArgs, deps: CardDependencies, io: CardCliIo): Promise<number> {
  const cards = await deps.cardRepository.findAll();
  const summaries = cards.map(({ body: _body, ...meta }) => meta);

  io.stdout(`${JSON.stringify(summaries, null, 2)}\n`);
  return 0;
}

async function runShow(args: ParsedArgs, deps: CardDependencies, io: CardCliIo): Promise<number> {
  const id = requireCardId(args, io);
  if (id === null) return 1;

  const card = await deps.cardRepository.findById(id);
  if (card === null) {
    io.stderr(`カードが見つかりません: ${id}\n`);
    return 1;
  }

  io.stdout(serializeCard(card));
  return 0;
}

async function runCreate(args: ParsedArgs, deps: CardDependencies, io: CardCliIo): Promise<number> {
  const title = args.flags.get('--title');
  if (typeof title !== 'string' || title.trim() === '') {
    io.stderr('--title を指定してください\n');
    return 1;
  }

  const id = args.flags.get('--id');
  const body = await io.readStdin();

  const result = await deps.createCardCommand({
    title: title.trim(),
    id: typeof id === 'string' ? id : undefined,
    body: body ?? undefined,
    createdAt: io.now(),
  });

  return report(result, io);
}

async function runBody(args: ParsedArgs, deps: CardDependencies, io: CardCliIo): Promise<number> {
  const id = requireCardId(args, io);
  if (id === null) return 1;

  const body = await io.readStdin();
  if (body === null) {
    io.stderr('本文を標準入力から渡してください\n');
    return 1;
  }

  const existing = await deps.cardRepository.findById(id);
  if (existing === null) {
    io.stderr(`カードが見つかりません: ${id}\n`);
    return 1;
  }

  // 人の判断はレビューログにだけ残る。本文の差し替えでそれを書き換えさせない
  if (!isDeepStrictEqual(parseReviewLog(existing.body), parseReviewLog(body))) {
    io.stderr(
      '## レビュー のエントリが変わる差し替えはできません。提出 / 再提出は submit で追記してください\n'
    );
    return 1;
  }

  return report(await deps.updateCardBodyCommand({ id, body: trimNewlines(body) }), io);
}

async function runBranch(args: ParsedArgs, deps: CardDependencies, io: CardCliIo): Promise<number> {
  const id = requireCardId(args, io);
  if (id === null) return 1;

  const clear = args.flags.get('--clear') === true;
  const name = args.positionals[1];

  if (clear === (name !== undefined)) {
    io.stderr('ブランチ名か --clear のどちらか一方を指定してください\n');
    return 1;
  }

  const result = await deps.updateCardMetaCommand({
    id,
    patch: { branch: clear ? null : (name ?? null) },
  });

  return report(result, io);
}

async function runSubmit(args: ParsedArgs, deps: CardDependencies, io: CardCliIo): Promise<number> {
  const id = requireCardId(args, io);
  if (id === null) return 1;

  const reason = args.flags.get('--reason');

  const result = await deps.appendReviewCommand({
    id,
    gate: 'plan',
    kind: args.flags.get('--resubmit') === true ? '再提出' : '提出',
    reason: typeof reason === 'string' ? reason : '',
    at: io.now(),
  });

  return report(result, io);
}

// ============================================================
// ヘルパー
// ============================================================

/** 前後の改行だけを落とす。Markdown の行頭の空白は意味を持つので trim しない */
function trimNewlines(text: string): string {
  return text.replace(/^\n+/, '').replace(/\n+$/, '');
}

function requireCardId(args: ParsedArgs, io: CardCliIo): CardId | null {
  const parsed = CardIdSchema.safeParse(args.positionals[0]);

  if (!parsed.success) {
    io.stderr('カード ID（kebab-case）を指定してください\n');
    return null;
  }

  return parsed.data as CardId;
}

type CardResult =
  | { readonly ok: true; readonly value: Card }
  | { readonly ok: false; readonly error: CreateCardError | UpdateCardError };

/** 成功なら書き込んだカードの ID を出す。失敗なら理由を stderr に出す */
function report(result: CardResult, io: CardCliIo): number {
  if (result.ok) {
    io.stdout(`${result.value.id}\n`);
    return 0;
  }

  io.stderr(`${describeError(result.error)}\n`);
  return 1;
}

function describeError(error: CreateCardError | UpdateCardError): string {
  switch (error.type) {
    case 'CardNotFound':
      return `カードが見つかりません: ${error.id}`;
    case 'DuplicateCardId':
      return `同じ ID のカードが既にあります: ${error.id}`;
    case 'InvalidCardId':
      return `カード ID が不正です: ${error.reason}`;
  }
}
