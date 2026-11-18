import { z } from 'zod';
import { err, ok, type Result } from '../../shared/result.js';
import { CardIdSchema } from '../../shared/schemas/common.js';
import {
  LOOP_ACTIONS,
  LOOP_ID_PATTERN,
  LOOP_IMPL_STEPS,
  LOOP_RESULTS,
  type LoopCurrentAction,
  type LoopFinishResult,
  type LoopImplStep,
  type LoopStep,
} from '../models/loop-step.js';
import { fromLogStamp, toLogStamp } from '../../cards/repositories/card-files.js';
import type { DocumentStore } from '../../infrastructure/document-store.js';
import type { ImplStep } from '../services/impl-step.js';
import type { NextActionKind } from '../services/next-action.js';

// ============================================================
// ループの 1 手の記録 — 置き場所の `loop` の文書の形と読み書き
// ============================================================

/**
 * 1 手の記録は、置き場所の `loop` のコレクションに 1 件 1 文書で置く。文書の ID は次の形で、下の「ファイル名」の `.json` を除いたものである。
 *
 * ```
 * loop/<開始の時刻>.<ループの識別子>        時刻は判断の文書と同じ `toLogStamp` の形
 * loop/<開始の時刻>.<ループの識別子>-2      同じ時刻と識別子が重なったら連番を付ける
 * ```
 *
 * 開始で `finishedAt` / `result` を null にしてファイルを作り、終了で同じファイルに 1 度だけ埋める。
 * 以前は手順書の版・トークン・時間（`harness` / `tokens` / `durationMs`）も書いていた。古い記録に残る項目は読むときに捨てる。
 * 終わった記録（`result` が null でない）は書き換えない。
 * 書き込みは `DocumentStore` を受け取る関数にし、`DocumentStore.transact` の中から呼ぶ。
 * カードの中（`cards/<id>/`）には置かない。ループの状態はカードの属性ではない。
 */
export const LOOP_COLLECTION = 'loop';

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
 * `LoopCurrentAction`（今の手）と `NextActionKind`、`LoopImplStep` と `ImplStep` が食い違えば、ここで型エラーになる。
 * 過去の手（`LOOP_PAST_ACTIONS`）は記録を読むためだけにあり、次の一手とは突き合わせない。
 * `ai-board loop start` は受け付ける手と段の一覧を実行時の値として要るので、型と配列を 2 か所に持つ。そのための縛り
 */
export const LOOP_VOCABULARY_IN_SYNC: Same<LoopCurrentAction, NextActionKind> &
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
 * `loop` の記録を全部読む。読めない文書（項目が不正、ID と中身が食い違う）は警告して読み飛ばす。
 * 1 つの文書でボード全体を止めない。
 */
function readStored(store: Pick<DocumentStore, 'list'>): StoredLoopStep[] {
  const stored: StoredLoopStep[] = [];
  for (const doc of store.list(LOOP_COLLECTION)) {
    const file = `${doc.id}.json`;
    const step = parseLoopStep(doc.data);
    if (step === null || !matchesFileName(file, step)) {
      console.warn(
        `[ai-board] ループの記録を読み飛ばしました: ${LOOP_COLLECTION}/${doc.id} — 名前か中身が不正です`
      );
      continue;
    }
    stored.push({ file, step });
  }

  return stored.sort(byStart);
}

function byStart(a: StoredLoopStep, b: StoredLoopStep): number {
  const diff = Date.parse(a.step.startedAt) - Date.parse(b.step.startedAt);
  if (diff !== 0) return diff;
  return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

/** 読める記録を開始の時刻の順に返す */
export function readLoopSteps(store: Pick<DocumentStore, 'list'>): LoopStep[] {
  return readStored(store).map(({ step }) => step);
}

/** 置き場所の `loop` を読むリポジトリ */
export function createDocLoopHistoryRepository(
  store: Pick<DocumentStore, 'list'>
): LoopHistoryRepository {
  return {
    findAll: () => Promise.resolve(readLoopSteps(store)),
  };
}

/** 記録の中身を文書にする。項目の順をスキーマで決める */
function loopStepData(step: LoopStep): Record<string, unknown> {
  return LoopStepSchema.parse(step) as Record<string, unknown>;
}

function docIdOf(file: string): string {
  return file.slice(0, -'.json'.length);
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
  readonly action: LoopCurrentAction;
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
  store: Pick<DocumentStore, 'list' | 'set'>,
  input: LoopStartInput
): Result<LoopStartOutcome, LoopWriteError> {
  const startedAt = normalizeTime(input.startedAt);
  if (startedAt === null) return err({ type: 'InvalidLoopTime', at: input.startedAt });

  const stored = readStored(store);
  const taken = new Set(store.list(LOOP_COLLECTION).map((doc) => `${doc.id}.json`));

  const file = loopFileName(startedAt, input.loop, taken);
  if (file === null) return err({ type: 'InvalidLoopTime', at: input.startedAt });

  const interrupted: LoopStep[] = [];
  for (const { file: openFile, step } of stored) {
    if (step.loop !== input.loop || step.result !== null) continue;

    const closed: LoopStep = { ...step, finishedAt: startedAt, result: 'interrupted' };
    store.set(LOOP_COLLECTION, docIdOf(openFile), loopStepData(closed));
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
  };
  store.set(LOOP_COLLECTION, docIdOf(file), loopStepData(started));

  return ok({ started, interrupted });
}

export interface LoopFinishInput {
  readonly loop: string;
  readonly cardId: string;
  readonly result: LoopFinishResult;
  readonly finishedAt: string;
}

/**
 * 終了を書く。そのループの終わっていない記録を 1 つ選び、終了と結果を埋める。
 *
 * 終わっていない記録が無い、または `cardId` が食い違えば拒む。
 * 終わっていない記録が 2 つ以上残っていれば（開始が閉じるので通常は起きない）、最も新しいものを選ぶ。
 */
export function writeLoopFinish(
  store: Pick<DocumentStore, 'list' | 'set'>,
  input: LoopFinishInput
): Result<LoopStep, LoopWriteError> {
  const finishedAt = normalizeTime(input.finishedAt);
  if (finishedAt === null) return err({ type: 'InvalidLoopTime', at: input.finishedAt });

  const running = readStored(store).filter(
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
  };
  store.set(LOOP_COLLECTION, docIdOf(target.file), loopStepData(finished));

  return ok(finished);
}

/** 時刻を `toISOString` の形にそろえる。読めなければ null */
function normalizeTime(at: string): string | null {
  const ms = Date.parse(at);
  if (Number.isNaN(ms) || toLogStamp(at) === null) return null;
  return new Date(ms).toISOString();
}
