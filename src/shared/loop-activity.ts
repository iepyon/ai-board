import { LOOP_RESULT_LABELS, type LoopStep } from './loop-step.js';

// ============================================================
// ループの様子 — トップバーと `status` に出す要約の純関数
// ============================================================

/**
 * ボードに載せるループの様子（`Board.loop`）。
 *
 * - `running`: 終わっていない記録。ループごとに高々 1 件（開始の時刻の順）
 * - `lastFinishedAt`: 最後に終えた手の時刻（途切れたものも含む）。終えた手が無ければ null
 */
export interface BoardLoop {
  readonly running: readonly LoopStep[];
  readonly lastFinishedAt: string | null;
}

/** 要約の種類。画面は色分けに使う */
export type LoopActivityState = 'running' | 'idle' | 'none';

export interface LoopActivitySummary {
  readonly state: LoopActivityState;
  /** 「ループ: …」の 1 行 */
  readonly text: string;
}

/**
 * 全カードの記録から `BoardLoop` を作る。
 *
 * 同じループに終わっていない記録が 2 つ以上あれば（開始が閉じるので通常は起きない）、最も新しいものだけを数える。
 */
export function toBoardLoop(steps: readonly LoopStep[]): BoardLoop {
  const latestRunning = new Map<string, LoopStep>();
  let lastFinishedAt: string | null = null;

  for (const step of steps) {
    if (step.result === null) {
      const current = latestRunning.get(step.loop);
      if (current === undefined || timeOf(step.startedAt) >= timeOf(current.startedAt)) {
        latestRunning.set(step.loop, step);
      }
      continue;
    }
    if (
      step.finishedAt !== null &&
      (lastFinishedAt === null || timeOf(step.finishedAt) > timeOf(lastFinishedAt))
    ) {
      lastFinishedAt = step.finishedAt;
    }
  }

  const running = [...latestRunning.values()].sort(
    (a, b) => timeOf(a.startedAt) - timeOf(b.startedAt)
  );
  return { running, lastFinishedAt };
}

/**
 * ループの様子を 1 行にする。経過時間は `generatedAt` までを数え、今の時刻は読まない。
 *
 * - 触っている: 「ループ: <カード> を <手> 中（12 分）」。複数のループなら「、」でつなぐ
 * - 触っていない: 「ループ: 最後の手から 40 分」
 * - 記録が無い: 「ループ: 記録なし」
 *
 * `titleOf` はカード ID からタイトルを引く。見つからなければ ID のまま出す。
 */
export function summarizeLoop(
  loop: BoardLoop,
  generatedAt: string,
  titleOf: (cardId: string) => string | null = () => null
): LoopActivitySummary {
  if (loop.running.length > 0) {
    const parts = loop.running.map(
      (step) =>
        `${titleOf(step.cardId) ?? step.cardId} を ${describeAction(step)} 中（${formatElapsed(step.startedAt, generatedAt)}）`
    );
    return { state: 'running', text: `ループ: ${parts.join('、')}` };
  }

  if (loop.lastFinishedAt !== null) {
    return {
      state: 'idle',
      text: `ループ: 最後の手から ${formatElapsed(loop.lastFinishedAt, generatedAt)}`,
    };
  }

  return { state: 'none', text: 'ループ: 記録なし' };
}

/** そのカードを今触っている記録。無ければ null */
export function runningStepOf(loop: BoardLoop, cardId: string): LoopStep | null {
  return loop.running.find((step) => step.cardId === cardId) ?? null;
}

/** そのカードを今ループが触っているか */
export function isCardRunning(loop: BoardLoop, cardId: string): boolean {
  return runningStepOf(loop, cardId) !== null;
}

/** 手と段。`implement（task）` */
export function describeAction(step: Pick<LoopStep, 'action' | 'step'>): string {
  return step.step === null ? step.action : `${step.action}（${step.step}）`;
}

/**
 * `from` から `to` までの経過時間。「12 分」「2 時間 5 分」「3 日 4 時間」。
 * 負になれば 0 分にし、読めない時刻は「—」にする。
 */
export function formatElapsed(from: string, to: string): string {
  const ms = timeOf(to) - timeOf(from);
  if (Number.isNaN(ms)) return '—';

  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} 分`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 時間 ${minutes % 60} 分`;

  return `${Math.floor(hours / 24)} 日 ${hours % 24} 時間`;
}

/**
 * 記録の中に終わっていないものがあるか。カードの `loopSteps` から、そのカードを今触っているかを見る
 * （画面のカードの行の「AI 稼働中」の印）
 */
export function hasRunningStep(steps: readonly Pick<LoopStep, 'result'>[]): boolean {
  return steps.some((step) => step.result === null);
}

// ------------------------------------------------------------
// 詳細パネルの「ループの手」の書式
// ------------------------------------------------------------

/** 1 手の始まりから終わりまでの時間。「35 秒」「1 分 35 秒」「2 時間 5 分」。無ければ「—」 */
export function formatDurationMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;

  return `${Math.floor(minutes / 60)} 時間 ${minutes % 60} 分`;
}

/** トークン。「812」「81k」「1.2M」。無ければ「—」 */
export function formatTokens(tokens: number | null): string {
  if (tokens === null || !Number.isFinite(tokens) || tokens < 0) return '—';
  if (tokens < 1000) return String(tokens);

  // 千で丸めて 1000 に届くもの（999,500 以上）は「1000k」ではなく M の書式へ進める
  const thousands = Math.round(tokens / 1000);
  if (thousands < 1000) return `${thousands}k`;

  return `${(tokens / 1_000_000).toFixed(1)}M`;
}

/** 結果の語。終わっていなければ「動作中」 */
export function describeResult(step: Pick<LoopStep, 'result'>): string {
  return step.result === null ? '動作中' : LOOP_RESULT_LABELS[step.result];
}

/** 手の一覧を新しい順に並べる（詳細パネルは新しい手を上に出す） */
export function newestFirst<T extends Pick<LoopStep, 'startedAt'>>(steps: readonly T[]): T[] {
  return [...steps].sort((a, b) => timeOf(b.startedAt) - timeOf(a.startedAt));
}

function timeOf(iso: string): number {
  return Date.parse(iso);
}
