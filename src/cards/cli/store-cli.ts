import { isErr, type Result } from '../../shared/result.js';
import { SEQ_PATTERN, type MirrorSync } from '../../infrastructure/artifact-mirror-store.js';
import {
  checkMeta,
  copyDocuments,
  readerOf,
  type DocumentStore,
} from '../../infrastructure/document-store.js';
import { CARD_COLLECTION } from '../repositories/card-files.js';
import { describeStoreError } from '../../infrastructure/store-messages.js';
import type { ImportDocument } from '../repositories/data-branch-import.js';

// ============================================================
// ai-board store — 置き場所（Artifact の DB）と手元の写し・送る箱の行き来
// ============================================================

/**
 * node の CLI は Artifact の DB に届かないので、DB との行き来は Claude が `ArtifactData` のツールで行い、
 * CLI はその前後の手元の段（写しへの取り込み・送る箱の出し入れ）だけを受け持つ。手順は `board-store` のスキルにある。
 *
 * - `pull`: `ArtifactData` の `list` が `out_dir` に書き出したディレクトリを、写しに取り込む
 * - `outbox`: 送る箱の書き込みを、`ArtifactData` の `batch` の `writes` にそのまま渡せる形で出す
 * - `ack` / `discard`: 送り終えた束を送る箱から消す / 改訂がぶつかったので捨てて写しを戻す
 * - `init` / `import`: 空の置き場所を始める / データ用ブランチから移す。どちらも書き込みを送る箱に積むだけ
 *
 * カードの書き込みの口（AI に許す usecase）はここに無い。`import` は人の判断を含む移行なので、人が頼んだときだけ使う。
 */
export const STORE_USAGE = `使い方: ai-board store <command> [--root <path>]

置き場所（Artifact の DB）と、手元の写し・送る箱の間を行き来する。
DB との読み書きは Claude が ArtifactData で行う（手順は board-store のスキル）。

Commands:
  pull --from <dir>     ArtifactData の list が out_dir に書き出したディレクトリを、写しに取り込む
                        （写しを丸ごと入れ替える。送る箱が空でなければ拒む）
  outbox [--json]       送る箱の書き込みを出す。--json は ArtifactData の batch の writes に
                        そのまま渡せる形（{"batches":[{"seq","label","writes":[...]}]}、1 つ 50 件まで）
  ack --through <seq>   送り終えた束（連番が <seq> 以下）を送る箱から消す。outbox を読んだ後に
                        ほかのプロセスが積んだ束は残す
  discard               送る箱を捨て、写しを積む前に戻す（batch が既にある改訂で拒まれたとき）
  init                  空の置き場所に最初の文書（board/meta）を積む
  import --from <dir>   データ用ブランチ（ai-board/data）の clone から、カード・判断・並び順を積む
                        （写しにカードが 1 枚でもあれば拒む）
  seed [--from <dir>]   seed のファイル（既定は .ai-board/seed/）から、まだ無いカードを起票する
                        （ai-board card seed と同じ）
`;

export interface StoreCliDependencies {
  /** 置き場所と、写しの行き来の口。`ArtifactMirrorStore` が満たす */
  readonly store: DocumentStore & MirrorSync;
  /** データ用ブランチの clone を読む（`import`） */
  readonly readDataBranch: (dir: string) => Result<ImportDocument[], string>;
  /** `seed` を `ai-board card seed --from <dir>` に渡す */
  readonly runSeed: (dir: string) => Promise<number>;
  /** `seed` の既定のディレクトリ */
  readonly seedDir: string;
}

export interface StoreCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const COMMANDS = ['pull', 'outbox', 'ack', 'discard', 'init', 'import', 'seed'] as const;
type StoreCommand = (typeof COMMANDS)[number];

export function isStoreCommand(value: string | undefined): value is StoreCommand {
  return value !== undefined && (COMMANDS as readonly string[]).includes(value);
}

type Flags = ReadonlyMap<string, string | true>;
type Handler = (flags: Flags, deps: StoreCliDependencies, io: StoreCliIo) => Promise<number>;

const HANDLERS: Readonly<Record<StoreCommand, Handler>> = {
  pull: runPull,
  outbox: runOutbox,
  ack: runAck,
  discard: runDiscard,
  init: runInit,
  import: runImport,
  seed: (flags, deps) => {
    const from = flags.get('--from');
    return deps.runSeed(typeof from === 'string' ? from : deps.seedDir);
  },
};

function isHelp(command: string | undefined, rest: readonly string[]): boolean {
  return (
    command === undefined ||
    command === '--help' ||
    command === '-h' ||
    rest.includes('--help') ||
    rest.includes('-h')
  );
}

export async function runStoreCli(
  argv: readonly string[],
  deps: StoreCliDependencies,
  io: StoreCliIo
): Promise<number> {
  const [command, ...rest] = argv;
  if (isHelp(command, rest)) {
    io.stderr(STORE_USAGE);
    return 0;
  }
  if (!isStoreCommand(command)) {
    io.stderr(`不明なコマンドです: ${String(command)}\n${STORE_USAGE}`);
    return 1;
  }

  const flags = parseFlags(rest);
  if (typeof flags === 'string') return fail(io, flags);

  return HANDLERS[command](flags, deps, io);
}

async function runPull(flags: Flags, deps: StoreCliDependencies, io: StoreCliIo): Promise<number> {
  const from = flags.get('--from');
  if (typeof from !== 'string')
    return fail(io, '--from に out_dir のディレクトリを指定してください');

  const pulled = await deps.store.pull(from);
  if (isErr(pulled)) return fail(io, describeStoreError(pulled.error));

  io.stdout(`${pulled.value.count} 件の文書を写しに取り込みました\n`);
  const checked = checkMeta(deps.store);
  if (isErr(checked)) io.stderr(`${describeStoreError(checked.error)}\n`);
  return 0;
}

async function runOutbox(
  flags: Flags,
  deps: StoreCliDependencies,
  io: StoreCliIo
): Promise<number> {
  const batches = deps.store.outbox();
  if (flags.get('--json') === true) {
    io.stdout(`${JSON.stringify({ batches }, null, 2)}\n`);
  } else if (batches.length === 0) {
    io.stdout('送る箱は空です\n');
  } else {
    for (const batch of batches) io.stdout(`${batch.label}（${batch.writes.length} 件）\n`);
  }
  return 0;
}

async function runAck(flags: Flags, deps: StoreCliDependencies, io: StoreCliIo): Promise<number> {
  const through = flags.get('--through');
  if (typeof through !== 'string' || !SEQ_PATTERN.test(through)) {
    return fail(
      io,
      '--through に送り終えた最後の束の連番（outbox --json の seq）を指定してください'
    );
  }
  const acked = await deps.store.ack(through);
  if (isErr(acked)) return fail(io, describeStoreError(acked.error));
  io.stdout(
    `送り終えた ${acked.value} 束を送る箱から消しました（残り ${deps.store.pendingWrites()} 束）\n`
  );
  return 0;
}

async function runDiscard(
  _flags: Flags,
  deps: StoreCliDependencies,
  io: StoreCliIo
): Promise<number> {
  const discarded = await deps.store.discard();
  if (isErr(discarded)) return fail(io, describeStoreError(discarded.error));
  io.stdout(
    `送る箱を捨て、写しを戻しました（${discarded.value} 束）。取り込み直してから、元のコマンドを走らせ直してください\n`
  );
  return 0;
}

async function runInit(_flags: Flags, deps: StoreCliDependencies, io: StoreCliIo): Promise<number> {
  const result = await deps.store.initialize();
  if (isErr(result)) return fail(io, describeStoreError(result.error));
  if (!result.value)
    return fail(io, '置き場所は既に始まっています（写しに board/meta があります）');
  io.stdout(
    '置き場所の最初の文書を送る箱に積みました。送り出してください（board-store のスキル）\n'
  );
  return 0;
}

async function runImport(
  flags: Flags,
  deps: StoreCliDependencies,
  io: StoreCliIo
): Promise<number> {
  const from = flags.get('--from');
  if (typeof from !== 'string') {
    return fail(io, '--from にデータ用ブランチ（ai-board/data）の clone を指定してください');
  }

  const checked = await deps.store.check();
  if (isErr(checked)) return fail(io, describeStoreError(checked.error));

  const docs = deps.readDataBranch(from);
  if (isErr(docs)) return fail(io, docs.error);

  const result = await copyDocuments<'NotEmpty'>(
    readerOf(docs.value),
    deps.store,
    'データ用ブランチから移す',
    { refuse: (to) => (to.list(CARD_COLLECTION).length > 0 ? 'NotEmpty' : null) }
  );

  if (isErr(result)) {
    return fail(
      io,
      result.error === 'NotEmpty'
        ? '写しに既にカードがあるため、移しません（二重に移さないため）'
        : describeStoreError(result.error)
    );
  }

  const cards = docs.value.filter((doc) => doc.collection === CARD_COLLECTION).length;
  io.stdout(
    `${cards} 枚のカードと ${result.value - cards} 件の文書（判断・並び順）を送る箱に積みました。送り出してください（board-store のスキル）\n`
  );
  return 0;
}

// ============================================================
// ヘルパー
// ============================================================

const VALUE_FLAGS = new Set(['--from', '--through']);
const BOOLEAN_FLAGS = new Set(['--json']);

function parseFlags(argv: readonly string[]): ReadonlyMap<string, string | true> | string {
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return `${arg} には値を指定してください`;
      flags.set(arg, value);
      i += 1;
    } else if (BOOLEAN_FLAGS.has(arg)) {
      flags.set(arg, true);
    } else {
      return `不明な引数です: ${arg}`;
    }
  }
  return flags;
}

function fail(io: StoreCliIo, message: string): number {
  io.stderr(`${message}\n`);
  return 1;
}
