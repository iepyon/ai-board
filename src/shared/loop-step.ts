/**
 * ループの 1 手の記録の語彙。
 *
 * 1 手の記録は、ループ（`/board-loop` を動かした本筋のセッション）が 1 つの手を始めてから終えるまでを 1 件にしたもの。
 * 本筋のセッションが手の始まりに `ai-board loop start`、終わりに `finish` を書き（`src/board/cli/loop-cli.ts`）、
 * データ用ブランチの `loop/` に置く。
 * ステージの導出にも次の一手にも使わない。ループの状態はカードの属性ではない。
 * `status` の要約（`src/shared/loop-activity.ts`）からも語を引くので、`src/shared/` に置く。
 */

/**
 * ループが今進める手。`next-action.ts` の `NextActionKind` と同じ値で、
 * 食い違えば `loop-history.repository.ts` の型の突き合わせで型エラーになる。
 * `ai-board loop start --action` に渡せるのはこれだけ。
 */
export const LOOP_CURRENT_ACTIONS = ['plan', 'revise-plan', 'implement', 'fix-pr'] as const;

export type LoopCurrentAction = (typeof LOOP_CURRENT_ACTIONS)[number];

/**
 * 廃止した手。動作確認の列とともに消えた `revise-impl`（動作確認で差し戻された実装を直す）と `ready`（動作確認の後に Ready にする）。
 * データ用ブランチの `loop/` に残る過去の記録を読むためだけに持ち、新しく書くことはできない。
 */
export const LOOP_PAST_ACTIONS = ['revise-impl', 'ready'] as const;

/** 記録に現れうる手。今の手のあとに過去の手を並べる（集計の並びにも使う） */
export const LOOP_ACTIONS = [...LOOP_CURRENT_ACTIONS, ...LOOP_PAST_ACTIONS] as const;

export type LoopAction = (typeof LOOP_ACTIONS)[number];

/** `implement` の手の段。`impl-step.ts` の `ImplStep` と同じ値（突き合わせは `LOOP_ACTIONS` と同じ） */
export const LOOP_IMPL_STEPS = ['task', 'review', 'close'] as const;

export type LoopImplStep = (typeof LOOP_IMPL_STEPS)[number];

/**
 * 1 手の結果。
 *
 * - `advanced` / `held` / `stopped`: 手の終わりに決める `結果:` の語（進めた / 保留して止まった / 止まった）に 1 対 1 で対応する
 * - `failed`: レビューの段で、`board-reviewer` のサブエージェントの呼び出しそのものが失敗した
 * - `unknown`: 結果の語が決まらなかった（`board-reviewer` の報告に結果の語が無かった、など）
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

/**
 * 1 手の記録。時刻は ISO 8601。
 *
 * 開始では `finishedAt` / `result` が null で、終了で 1 度だけ埋まる。
 * `result` が null の記録が「終わっていない記録」（今触っている手）である。
 */
export interface LoopStep {
  /** ループの識別子（本筋のセッションの ID など） */
  readonly loop: string;
  readonly cardId: string;
  readonly action: LoopAction;
  /** `implement` の手の段。分からなければ null */
  readonly step: LoopImplStep | null;
  /** 手を進めたサブエージェントの名前（レビューの段の `board-reviewer-…`）。本筋のセッションが自分で進めた手は null */
  readonly agent: string | null;
  readonly startedAt: string;
  /** 終えた時刻。`interrupted` で閉じた記録は、閉じた時刻（次の手を始めた時刻）にする */
  readonly finishedAt: string | null;
  readonly result: LoopResult | null;
}

/** ループの識別子の形。ファイル名に入るので、英数字と `.` `_` `-` だけにする */
export const LOOP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 今の手か。`ai-board loop start` が受け付けるかの判定に使う */
export function isLoopCurrentAction(value: string): value is LoopCurrentAction {
  return (LOOP_CURRENT_ACTIONS as readonly string[]).includes(value);
}

export function isLoopImplStep(value: string): value is LoopImplStep {
  return (LOOP_IMPL_STEPS as readonly string[]).includes(value);
}

export function isLoopFinishResult(value: string): value is LoopFinishResult {
  return (LOOP_FINISH_RESULTS as readonly string[]).includes(value);
}
