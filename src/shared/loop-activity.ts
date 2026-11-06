import type { LoopStep } from './loop-step.js';

// ============================================================
// ループの様子 — `status` に出す要約の純関数
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

function timeOf(iso: string): number {
  return Date.parse(iso);
}
