import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { err, ok, type Result } from '../../shared/result.js';
import { CardIdSchema } from '../../shared/schemas/common.js';
import {
  LOOP_ACTIONS,
  LOOP_ID_PATTERN,
  LOOP_IMPL_STEPS,
  LOOP_RESULTS,
  type LoopAction,
  type LoopFinishResult,
  type LoopImplStep,
  type LoopStep,
} from '../../shared/loop-step.js';
import { fromLogStamp, toLogStamp } from '../../cards/repositories/card-files.js';
import type { ImplStep } from '../services/impl-step.js';
import type { NextActionKind } from '../services/next-action.js';

// ============================================================
// ループの 1 手の記録 — データ用ブランチの `loop/` のファイルの形と読み書き
// ============================================================

/**
 * 1 手の記録は、データ用ブランチの `loop/` に 1 件 1 ファイルの JSON で置く。
 *
 * ```
 * loop/<開始の時刻>.<ループの識別子>.json        時刻は判断のファイルと同じ `toLogStamp` の形
 * loop/<開始の時刻>.<ループの識別子>-2.json      同じ時刻と識別子が重なったら連番を付ける
 * ```
 *
 * 開始で `finishedAt` / `result` / `tokens` / `durationMs` を null にしてファイルを作り、終了で同じファイルに 1 度だけ埋める。
 * 終わった記録（`result` が null でない）は書き換えない。
 * 書き込みは `dataDir` を受け取る関数にし、`DataStore.transact` の中から呼ぶ（取り直した最新の状態に対して書く）。
 * カードの中（`cards/<id>/`）には置かない。ループの状態はカードの属性ではない。
 */
export const LOOP_DIR = 'loop';

/** 1 手の記録を読むリポジトリ。ボードの組み立てが使う */
export interface LoopHistoryRepository {
  /** 読める記録を開始の時刻の順に返す。読めないファイルは警告して読み飛ばす */
  findAll(): Promise<LoopStep[]>;
}

// ------------------------------------------------------------
// 手と段の値は、次の一手（`next-action.ts` / `impl-step.ts`）と同じでなければならない
// ------------------------------------------------------------

/** 2 つの型が同じなら true、食い違えば never */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * `LoopAction` と `NextActionKind`、`LoopImplStep` と `ImplStep` が食い違えば、ここで型エラーになる。
 * `src/shared/` は web からも読むのでボードの型を import できず、値の一覧を 2 か所に持つための縛り
 */
export const LOOP_VOCABULARY_IN_SYNC: Same<LoopAction, NextActionKind> &
  Same<LoopImplStep, ImplStep> = true;

// ------------------------------------------------------------
// ファイル名
// ------------------------------------------------------------

const LOOP_FILE_NAME = /^(\d{8}T\d{6}\.\d{3}Z)\.([A-Za-z0-9][A-Za-z0-9._-]*)\.json$/;

/**
 * 記録のファイル名を決める。同じ名前が `taken` にあれば、`-2`、`-3` を付ける。
 * 時刻がファイル名にできなければ null。
 */
export function loopFileName(
  startedAt: string,
  loop: string,
  taken: ReadonlySet<string>
): string | null {
  const stamp = toLogStamp(startedAt);
  if (stamp === null) return null;

  const base = `${stamp}.${loop}`;
  if (!taken.has(`${base}.json`)) return `${base}.json`;

  let seq = 2;
  while (taken.has(`${base}-${seq}.json`)) seq += 1;

  return `${base}-${seq}.json`;
}

/**
 * 記録のファイル名を読む。形が違えば null。
 *
 * 識別子は `-` を含みうるので、末尾の `-2` が連番か識別子の一部かは名前だけでは決まらない。
 * `tail` に識別子と連番をまとめて返し、中身との突き合わせ（`matchesFileName`）で決める。
 */
export function parseLoopFileName(name: string): { at: string; tail: string } | null {
  const match = LOOP_FILE_NAME.exec(name);
  if (match === null) return null;

  const [, stamp, tail] = match;
  if (stamp === undefined || tail === undefined) return null;

  const at = fromLogStamp(stamp);
  return at === null ? null : { at, tail };
}

/** ファイル名の時刻と識別子が、中身と合っているか */
function matchesFileName(name: string, step: LoopStep): boolean {
  const parsed = parseLoopFileName(name);
  if (parsed === null) return false;
  if (toLogStamp(step.startedAt) !== toLogStamp(parsed.at)) return false;

  if (parsed.tail === step.loop) return true;
  const prefix = `${step.loop}-`;
  return parsed.tail.startsWith(prefix) && /^[1-9]\d*$/.test(parsed.tail.slice(prefix.length));
}

// ------------------------------------------------------------
// 中身
// ------------------------------------------------------------

const TimeSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: '時刻として読めません',
});

const CountSchema = z.number().int().nonnegative().nullable();

const LoopStepSchema = z
  .object({
    loop: z.string().regex(LOOP_ID_PATTERN),
    cardId: CardIdSchema,
    action: z.enum(LOOP_ACTIONS),
    step: z.enum(LOOP_IMPL_STEPS).nullable(),
    agent: z.string().min(1).max(200).nullable(),
    startedAt: TimeSchema,
    finishedAt: TimeSchema.nullable(),
    result: z.enum(LOOP_RESULTS).nullable(),
    tokens: CountSchema,
    durationMs: CountSchema,
  })
  .refine((value) => (value.result === null) === (value.finishedAt === null), {
    message: 'finishedAt と result は、どちらも埋まっているか、どちらも null でなければなりません',
  });

/** JSON から読んだ値を記録にする。形が合わなければ null */
export function parseLoopStep(json: unknown): LoopStep | null {
  const parsed = LoopStepSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** 記録のファイルの中身。項目の順をスキーマで決める */
export function serializeLoopStep(step: LoopStep): string {
  return `${JSON.stringify(LoopStepSchema.parse(step), null, 2)}\n`;
}

// ------------------------------------------------------------
// 読み出し
// ------------------------------------------------------------

/** 読めた記録とそのファイル名 */
interface StoredLoopStep {
  readonly file: string;
  readonly step: LoopStep;
}

/**
 * `loop/` の記録を全部読む。読めないファイル（JSON でない、項目が不正、ファイル名と中身が食い違う）は
 * 警告して読み飛ばす。1 つのファイルでボード全体を止めない。
 */
function readStored(dataDir: string): StoredLoopStep[] {
  const dir = path.join(dataDir, LOOP_DIR);
  if (!fs.existsSync(dir)) return [];

  const stored: StoredLoopStep[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;

    const step = readOne(path.join(dir, entry.name));
    if (step === null || !matchesFileName(entry.name, step)) {
      console.warn(
        `[ai-board] ループの記録を読み飛ばしました: ${LOOP_DIR}/${entry.name} — 名前か中身が不正です`
      );
      continue;
    }
    stored.push({ file: entry.name, step });
  }

  return stored.sort(byStart);
}

function readOne(file: string): LoopStep | null {
  try {
    return parseLoopStep(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch {
    return null;
  }
}

function byStart(a: StoredLoopStep, b: StoredLoopStep): number {
  const diff = Date.parse(a.step.startedAt) - Date.parse(b.step.startedAt);
  if (diff !== 0) return diff;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

/** 読める記録を開始の時刻の順に返す */
export function readLoopSteps(dataDir: string): LoopStep[] {
  return readStored(dataDir).map(({ step }) => step);
}

/** データのワークツリーの `loop/` を読むリポジトリ */
export function createFileLoopHistoryRepository(dataDir: string): LoopHistoryRepository {
  return {
    findAll: () => Promise.resolve(readLoopSteps(dataDir)),
  };
}

// ------------------------------------------------------------
// 書き込み
// ------------------------------------------------------------

/** 書き込みを拒んだ理由 */
export type LoopWriteError =
  /** 時刻がファイル名にできない */
  | { readonly type: 'InvalidLoopTime'; readonly at: string }
  /** そのループに終わっていない記録が無い */
  | { readonly type: 'NoRunningLoopStep'; readonly loop: string }
  /** そのループの終わっていない記録が、別のカードのもの */
  | {
      readonly type: 'RunningLoopStepCardMismatch';
      readonly loop: string;
      readonly running: string;
      readonly given: string;
    };

export interface LoopStartInput {
  readonly loop: string;
  readonly cardId: string;
  readonly action: LoopAction;
  readonly step: LoopImplStep | null;
  readonly agent: string | null;
  readonly startedAt: string;
}

export interface LoopStartOutcome {
  readonly started: LoopStep;
  /** 同じループに残っていて、`interrupted` で閉じた記録 */
  readonly interrupted: readonly LoopStep[];
}

/**
 * 開始を書く。
 *
 * 同じループに終わっていない記録が残っていれば、`interrupted` で閉じてから新しい記録を作る。
 * 1 つのループは 1 度に 1 手しか渡さないので、残っているのは前の手の終了を書き損ねたものである。
 * 閉じた時刻は新しい手を始めた時刻にする（いつ途切れたかは分からないので、その上限）。
 */
export function writeLoopStart(
  dataDir: string,
  input: LoopStartInput
): Result<LoopStartOutcome, LoopWriteError> {
  const startedAt = normalizeTime(input.startedAt);
  if (startedAt === null) return err({ type: 'InvalidLoopTime', at: input.startedAt });

  const dir = path.join(dataDir, LOOP_DIR);
  const stored = readStored(dataDir);
  const taken = new Set(fs.existsSync(dir) ? fs.readdirSync(dir) : []);

  const file = loopFileName(startedAt, input.loop, taken);
  if (file === null) return err({ type: 'InvalidLoopTime', at: input.startedAt });

  const interrupted: LoopStep[] = [];
  for (const { file: openFile, step } of stored) {
    if (step.loop !== input.loop || step.result !== null) continue;

    const closed: LoopStep = { ...step, finishedAt: startedAt, result: 'interrupted' };
    fs.writeFileSync(path.join(dir, openFile), serializeLoopStep(closed));
    interrupted.push(closed);
  }

  const started: LoopStep = {
    loop: input.loop,
    cardId: input.cardId,
    action: input.action,
    step: input.step,
    agent: input.agent,
    startedAt,
    finishedAt: null,
    result: null,
    tokens: null,
    durationMs: null,
  };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), serializeLoopStep(started), { flag: 'wx' });

  return ok({ started, interrupted });
}

export interface LoopFinishInput {
  readonly loop: string;
  readonly cardId: string;
  readonly result: LoopFinishResult;
  readonly tokens: number | null;
  readonly durationMs: number | null;
  readonly finishedAt: string;
}

/**
 * 終了を書く。そのループの終わっていない記録を 1 つ選び、終了・結果・トークン・時間を埋める。
 *
 * 終わっていない記録が無い、または `cardId` が食い違えば拒む。
 * 終わっていない記録が 2 つ以上残っていれば（開始が閉じるので通常は起きない）、最も新しいものを選ぶ。
 */
export function writeLoopFinish(
  dataDir: string,
  input: LoopFinishInput
): Result<LoopStep, LoopWriteError> {
  const finishedAt = normalizeTime(input.finishedAt);
  if (finishedAt === null) return err({ type: 'InvalidLoopTime', at: input.finishedAt });

  const running = readStored(dataDir).filter(
    ({ step }) => step.loop === input.loop && step.result === null
  );
  const target = running.at(-1);
  if (target === undefined) return err({ type: 'NoRunningLoopStep', loop: input.loop });

  if (target.step.cardId !== input.cardId) {
    return err({
      type: 'RunningLoopStepCardMismatch',
      loop: input.loop,
      running: target.step.cardId,
      given: input.cardId,
    });
  }

  const finished: LoopStep = {
    ...target.step,
    finishedAt,
    result: input.result,
    tokens: input.tokens,
    durationMs: input.durationMs,
  };
  fs.writeFileSync(path.join(dataDir, LOOP_DIR, target.file), serializeLoopStep(finished));

  return ok(finished);
}

/** 時刻を `toISOString` の形にそろえる。読めなければ null */
function normalizeTime(at: string): string | null {
  const ms = Date.parse(at);
  if (Number.isNaN(ms) || toLogStamp(at) === null) return null;
  return new Date(ms).toISOString();
}
