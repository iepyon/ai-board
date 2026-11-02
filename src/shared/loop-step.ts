/**
 * ループの 1 手の記録の語彙。
 *
 * 1 手の記録は、監視役（`/board-loop`）がサブエージェントに手を渡してから、完了の通知を受けるまでを 1 件にしたもの。
 * データ用ブランチの `loop/` に置き、`ai-board loop start` / `finish` で書く（`src/board/cli/loop-cli.ts`）。
 * ステージの導出にも次の一手にも使わない。ループの状態はカードの属性ではない。
 * 画面からも語を引くので、web からも読める `src/shared/` に置く。
 */

/**
 * 監視役がサブエージェントに渡す手。`next-action.ts` の `NextActionKind` と同じ値で、
 * 食い違えば `loop-history.repository.ts` の型の突き合わせで型エラーになる。
 */
export const LOOP_ACTIONS = ['plan', 'revise-plan', 'implement', 'revise-impl', 'ready'] as const;

export type LoopAction = (typeof LOOP_ACTIONS)[number];

/** `implement` の手の段。`impl-step.ts` の `ImplStep` と同じ値（突き合わせは `LOOP_ACTIONS` と同じ） */
export const LOOP_IMPL_STEPS = ['task', 'review', 'close'] as const;

export type LoopImplStep = (typeof LOOP_IMPL_STEPS)[number];

/**
 * 1 手の結果。
 *
 * - `advanced` / `held` / `stopped`: サブエージェントの報告の `結果:` の語（進めた / 保留して止まった / 止まった）に 1 対 1 で対応する
 * - `failed`: サブエージェントの起動そのものが失敗した
 * - `unknown`: 報告に結果の語が無かった
 * - `interrupted`: 終了を書き損ねたまま、同じループが次の手を始めた。CLI が閉じるときにだけ付け、人は渡せない
 */
export const LOOP_RESULTS = [
  'advanced',
  'held',
  'stopped',
  'failed',
  'unknown',
  'interrupted',
] as const;

export type LoopResult = (typeof LOOP_RESULTS)[number];

/** `ai-board loop finish --result` で渡せる結果。`interrupted` は CLI が付けるので除く */
export const LOOP_FINISH_RESULTS = [
  'advanced',
  'held',
  'stopped',
  'failed',
  'unknown',
] as const satisfies readonly LoopResult[];

export type LoopFinishResult = (typeof LOOP_FINISH_RESULTS)[number];

/** 画面と `status` に出す結果の語 */
export const LOOP_RESULT_LABELS: Record<LoopResult, string> = {
  advanced: '進めた',
  held: '保留して止まった',
  stopped: '止まった',
  failed: '失敗した',
  unknown: '結果不明',
  interrupted: '途切れた',
};

/**
 * 1 手の記録。時刻は ISO 8601。
 *
 * 開始では `finishedAt` / `result` / `tokens` / `durationMs` が null で、終了で 1 度だけ埋まる。
 * `result` が null の記録が「終わっていない記録」（今触っている手）である。
 */
export interface LoopStep {
  /** ループの識別子（監視役のセッション ID など） */
  readonly loop: string;
  readonly cardId: string;
  readonly action: LoopAction;
  /** `implement` の手の段。分からなければ null */
  readonly step: LoopImplStep | null;
  /** サブエージェントの名前。渡されなければ null */
  readonly agent: string | null;
  readonly startedAt: string;
  /** 終えた時刻。`interrupted` で閉じた記録は、閉じた時刻（次の手を始めた時刻）にする */
  readonly finishedAt: string | null;
  readonly result: LoopResult | null;
  /** サブエージェントが使ったトークン。監視役が完了の通知から写す */
  readonly tokens: number | null;
  /** サブエージェントが動いていた時間。監視役が完了の通知から写す */
  readonly durationMs: number | null;
}

/** ループの識別子の形。ファイル名に入るので、英数字と `.` `_` `-` だけにする */
export const LOOP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isLoopAction(value: string): value is LoopAction {
  return (LOOP_ACTIONS as readonly string[]).includes(value);
}

export function isLoopImplStep(value: string): value is LoopImplStep {
  return (LOOP_IMPL_STEPS as readonly string[]).includes(value);
}

export function isLoopFinishResult(value: string): value is LoopFinishResult {
  return (LOOP_FINISH_RESULTS as readonly string[]).includes(value);
}

/** 終わっていない記録か */
export function isRunning(step: LoopStep): boolean {
  return step.result === null;
}
