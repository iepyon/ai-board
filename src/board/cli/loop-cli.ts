import { err, isErr } from '../../shared/result.js';
import { CardIdSchema } from '../../shared/schemas/common.js';
import {
  LOOP_CURRENT_ACTIONS,
  LOOP_FINISH_RESULTS,
  LOOP_ID_PATTERN,
  LOOP_IMPL_STEPS,
  isLoopCurrentAction,
  isLoopFinishResult,
  isLoopImplStep,
  type LoopCurrentAction,
  type LoopFinishResult,
  type LoopImplStep,
  type LoopStep,
} from '../../shared/loop-step.js';
import type { DataStore, DataStoreError } from '../../infrastructure/data-store.js';
import { describeDataStoreError } from '../../cards/cli/data-store-messages.js';
import {
  writeLoopFinish,
  writeLoopStart,
  type LoopStartOutcome,
  type LoopWriteError,
} from '../repositories/loop-history.repository.js';

// ============================================================
// ai-board loop — ループが 1 手の記録を書くための CLI
// ============================================================

/**
 * ループ（`/board-loop` を動かした本筋のセッション）だけが、手の始まりと終わりに使う。書くのはデータ用ブランチの `loop/` のファイルだけで、カードには書かない。
 *
 * カードについては「その ID のカードがあるか」を読む関数（`cardExists`）だけを受け取り、
 * カードのリポジトリの書き込みの口を持たない。`card-cli.ts` の書き込み境界には入口を足さない。
 * 書き込みは `DataStore.transact` の 1 操作として走らせる（取り直した最新の状態に対して書き、コミットして push する）。
 */
export const LOOP_USAGE = `使い方: ai-board loop <command> [--root <path>]

ループ（/board-loop を動かした本筋のセッション）が、手の始まりと終わりに 1 手の記録を書く
（データ用ブランチの loop/）。カードには書かない。

Commands:
  start  --loop <id> --card <cardId> --action <手> [--step <段>] [--agent <name>]
                           1 手の開始を書く。同じループの終わっていない記録は「途切れた」で閉じる
                           （--action は ${LOOP_CURRENT_ACTIONS.join(' / ')}。
                           --step は ${LOOP_IMPL_STEPS.join(' / ')} で、implement のときだけ）
  finish --loop <id> --card <cardId> --result <結果> [--tokens <n>] [--duration-ms <n>]
                           そのループの終わっていない記録に、終了・結果・トークン・時間を埋める
                           （--result は ${LOOP_FINISH_RESULTS.join(' / ')}。
                           --duration-ms を省くと、開始から終了までの時間で埋める）

--loop はループの識別子（英数字と . _ -、64 文字まで）。本筋のセッションの ID を渡す
--agent は手を進めたサブエージェントの名前。本筋のセッションが自分で進める手では渡さない
`;

export interface LoopCliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now: () => Date;
}

export interface LoopCliDependencies {
  /** データのワークツリー。書き込みは `transact` の中で行う */
  readonly store: Pick<DataStore, 'transact'>;
  /** その ID のカードがあるか。`transact` の中（取り直した後）で呼ぶ */
  readonly cardExists: (id: string) => Promise<boolean>;
}

/** CLI の検査で書き込みを拒んだ */
type LoopCliError = LoopWriteError | { readonly type: 'CardNotFound'; readonly id: string };

const FLAGS: Readonly<Record<'start' | 'finish', readonly string[]>> = {
  start: ['--loop', '--card', '--action', '--step', '--agent'],
  finish: ['--loop', '--card', '--result', '--tokens', '--duration-ms'],
};

/** `ai-board loop <command>` を実行し、終了コードを返す */
export async function runLoopCli(
  argv: readonly string[],
  deps: LoopCliDependencies,
  io: LoopCliIo
): Promise<number> {
  const [command, ...rest] = argv;

  if (command !== 'start' && command !== 'finish') {
    io.stderr(LOOP_USAGE);
    return command === undefined || command === '--help' || command === '-h' ? 0 : 1;
  }

  const flags = parseFlags(rest, FLAGS[command]);
  if (typeof flags === 'string') {
    io.stderr(`${flags}\n`);
    return 1;
  }

  return command === 'start' ? runStart(flags, deps, io) : runFinish(flags, deps, io);
}

// ============================================================
// サブコマンド
// ============================================================

async function runStart(
  flags: ReadonlyMap<string, string>,
  deps: LoopCliDependencies,
  io: LoopCliIo
): Promise<number> {
  const common = parseCommon(flags);
  if (typeof common === 'string') return fail(io, common);

  const action = flags.get('--action');
  if (action === undefined || !isLoopCurrentAction(action)) {
    return fail(io, `--action には ${LOOP_CURRENT_ACTIONS.join(' / ')} のどれかを指定してください`);
  }

  const parsedStep = parseStep(flags.get('--step'), action);
  if ('error' in parsedStep) return fail(io, parsedStep.error);
  const step = parsedStep.step;

  const agent = flags.get('--agent') ?? null;
  if (agent !== null && (agent.trim() === '' || agent.length > 200 || /[\r\n]/.test(agent))) {
    return fail(io, '--agent には 200 文字までの 1 行の名前を指定してください');
  }

  const startedAt = io.now().toISOString();
  const result = await deps.store.transact<LoopStartOutcome, LoopCliError>(
    `loop: start ${common.cardId} ${action}`,
    async (dataDir) => {
      if (!(await deps.cardExists(common.cardId))) {
        return err({ type: 'CardNotFound', id: common.cardId });
      }
      return writeLoopStart(dataDir, {
        loop: common.loop,
        cardId: common.cardId,
        action,
        step,
        agent,
        startedAt,
      });
    }
  );

  if (isErr(result)) return fail(io, describeError(result.error));

  for (const closed of result.value.interrupted) {
    io.stderr(
      `終わっていない前の記録を「途切れた」で閉じました: ${closed.cardId} ${closed.action}（${closed.startedAt} に開始）\n`
    );
  }
  io.stdout(`${describeStep(result.value.started)}\n`);
  return 0;
}

async function runFinish(
  flags: ReadonlyMap<string, string>,
  deps: LoopCliDependencies,
  io: LoopCliIo
): Promise<number> {
  const common = parseCommon(flags);
  if (typeof common === 'string') return fail(io, common);

  const resultFlag = flags.get('--result');
  if (resultFlag === undefined || !isLoopFinishResult(resultFlag)) {
    return fail(io, `--result には ${LOOP_FINISH_RESULTS.join(' / ')} のどれかを指定してください`);
  }
  const loopResult: LoopFinishResult = resultFlag;

  const tokens = parseCount(flags.get('--tokens'), '--tokens');
  if (typeof tokens === 'string') return fail(io, tokens);
  const durationMs = parseCount(flags.get('--duration-ms'), '--duration-ms');
  if (typeof durationMs === 'string') return fail(io, durationMs);

  const finishedAt = io.now().toISOString();
  const result = await deps.store.transact<LoopStep, LoopCliError>(
    (step) => `loop: finish ${step.cardId} ${step.action}`,
    (dataDir) =>
      Promise.resolve(
        writeLoopFinish(dataDir, {
          loop: common.loop,
          cardId: common.cardId,
          result: loopResult,
          tokens,
          durationMs,
          finishedAt,
        })
      )
  );

  if (isErr(result)) return fail(io, describeError(result.error));

  io.stdout(`${describeStep(result.value)}\n`);
  return 0;
}

// ============================================================
// 引数
// ============================================================

/** どのフラグも値を伴う。知らないフラグ・位置引数・重複は拒む */
export function parseFlags(
  argv: readonly string[],
  allowed: readonly string[]
): Map<string, string> | string {
  const flags = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (!allowed.includes(arg)) {
      return arg.startsWith('--') ? `不明なオプションです: ${arg}` : `余分な引数です: ${arg}`;
    }
    if (flags.has(arg)) return `${arg} が 2 回指定されています`;

    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) return `${arg} には値を指定してください`;

    flags.set(arg, value);
    i += 1;
  }

  return flags;
}

function parseCommon(
  flags: ReadonlyMap<string, string>
): { readonly loop: string; readonly cardId: string } | string {
  const loop = flags.get('--loop');
  if (loop === undefined || !LOOP_ID_PATTERN.test(loop)) {
    return '--loop にはループの識別子（英数字と . _ -、64 文字まで）を指定してください';
  }

  const card = CardIdSchema.safeParse(flags.get('--card'));
  if (!card.success) return '--card にはカード ID（kebab-case）を指定してください';

  return { loop, cardId: card.data };
}

/** `--step` の値。段の値も文字列なので、誤りは `error` で分けて返す */
function parseStep(
  value: string | undefined,
  action: LoopCurrentAction
): { readonly step: LoopImplStep | null } | { readonly error: string } {
  if (value === undefined) return { step: null };
  if (action !== 'implement')
    return { error: '--step は --action implement のときだけ指定できます' };
  if (!isLoopImplStep(value)) {
    return { error: `--step には ${LOOP_IMPL_STEPS.join(' / ')} のどれかを指定してください` };
  }
  return { step: value };
}

/** 0 以上の整数。省略は null */
function parseCount(value: string | undefined, option: string): number | null | string {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    return `${option} には 0 以上の整数を指定してください`;
  }
  return Number(value);
}

// ============================================================
// 出力
// ============================================================

function fail(io: LoopCliIo, message: string): number {
  io.stderr(`${message}\n`);
  return 1;
}

function describeStep(step: LoopStep): string {
  const stepPart = step.step === null ? '' : `（${step.step}）`;
  const resultPart = step.result === null ? '' : ` → ${step.result}`;
  return `${step.loop} ${step.cardId} ${step.action}${stepPart}${resultPart}`;
}

function describeError(error: LoopCliError | DataStoreError): string {
  switch (error.type) {
    case 'CardNotFound':
      return `カードが見つかりません: ${error.id}`;
    case 'InvalidLoopTime':
      return `時刻を記録のファイル名にできません: ${error.at}`;
    case 'NoRunningLoopStep':
      return `ループ ${error.loop} に終わっていない記録がありません（start を書いていないか、もう finish を書いています）`;
    case 'RunningLoopStepCardMismatch':
      return `ループ ${error.loop} の終わっていない記録は ${error.running} のものです（--card ${error.given} と食い違います）`;
    default:
      // 残りは DataStoreError。describeDataStoreError の switch が種別を網羅する
      return describeDataStoreError(error);
  }
}
