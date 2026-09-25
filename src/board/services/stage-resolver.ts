import { stageRank, type Stage } from '../../shared/schemas/common.js';
import type { Card } from '../../cards/models/card.js';
import type { GateState, ReviewGate } from '../../cards/models/review.js';
import { gateState, isAborted, parseReviewLog } from '../../cards/services/review-log.js';
import type { OpenSpecChangeState } from '../models/openspec-state.js';
import type { MrState } from '../models/mr-state.js';

// ============================================================
// ステージ導出 — このプロジェクトの核
// ============================================================

/**
 * 人が直接ドラッグで動かせるステージ。
 *
 * `startedAt` の打刻と取り消しに対応する 1 遷移だけ。
 * 残りは AI の成果物（openspec / GitLab）か、本文のレビューログが立てる。
 * レビューログへの書き込みはドラッグではなくボタンで行う。
 */
export const HUMAN_STAGES = ['idea', 'planning'] as const satisfies readonly Stage[];

export interface StageResolution {
  /** 表示する列 */
  readonly stage: Stage;
  /** そのステージになった理由。UI のツールチップに出す */
  readonly reason: string;
  /** 最新のレビューエントリが 中止 か。UI は既定でこのカードを畳む */
  readonly aborted: boolean;
  /** 各ゲートの通過状況。UI のボタン表示に使う */
  readonly gates: Readonly<Record<ReviewGate, GateState>>;
}

/**
 * カードのステージを決める純関数。副作用なし。
 *
 * 下記を上から評価し、最初に真になったものを採用する（＝最も進んだステージ）。
 * `stage` はどこにも保存しない。ここが唯一の決定点である。
 *
 * | # | stage       | 条件                                                 |
 * |---|-------------|------------------------------------------------------|
 * | 1 | merged      | archive に存在、または MR が merged                   |
 * | 2 | pr          | MR が opened                                          |
 * | 3 | impling     | plan 承認済み                                         |
 * | 4 | plan-review | proposal.md が存在し plan ゲートが none / submitted    |
 * | 5 | planning    | startedAt が非 null                                   |
 * | 6 | idea        | 既定                                                  |
 *
 * 否決の差し戻しは専用ルールを持たない。`gate = rejected` のとき
 * その工程のレビュー行と承認行が両方外れ、1 つ手前の列へ自然に落ちる。
 */
export function resolveStage(
  card: Card,
  openspec: OpenSpecChangeState | null,
  mr: MrState | null
): StageResolution {
  const facts = toFacts(card, openspec, mr);
  const { stage, reason } = deriveStage(facts);

  return { stage, reason, aborted: facts.aborted, gates: facts.gates };
}

/**
 * カードの `startedAt` を外したときに残るステージ＝AI の成果物と
 * 人のレビュー記録が課す下限。
 *
 * 導出ルールを二重に持たないよう、`startedAt` を落としたカードで
 * 同じ `deriveStage` を呼ぶ。
 */
export function resolveFloorStage(
  card: Card,
  openspec: OpenSpecChangeState | null,
  mr: MrState | null
): Stage {
  return deriveStage(toFacts({ ...card, startedAt: null }, openspec, mr)).stage;
}

/**
 * その下限のもとで、人が手で入れられる列。
 *
 * 下限より前の列へは戻せない（実態が変わらないため着地できない）ので、
 * `rank(列) >= rank(下限)` を満たす人の列だけを返す。
 */
export function droppableStages(floor: Stage): Stage[] {
  return HUMAN_STAGES.filter((stage) => stageRank(stage) >= stageRank(floor));
}

interface Derivation {
  readonly stage: Stage;
  readonly reason: string;
}

/** 判定に必要な事実をまとめたもの */
interface Facts {
  readonly card: Card;
  readonly openspec: OpenSpecChangeState | null;
  readonly mr: MrState | null;
  readonly gates: Readonly<Record<ReviewGate, GateState>>;
  readonly aborted: boolean;
}

function toFacts(card: Card, openspec: OpenSpecChangeState | null, mr: MrState | null): Facts {
  const entries = parseReviewLog(card.body);

  return {
    card,
    openspec,
    mr,
    gates: {
      plan: gateState(entries, 'plan', card.skipGates),
    },
    aborted: isAborted(entries),
  };
}

/**
 * 進んだステージから順に並べたルール。最初に非 null を返したものが採用される。
 *
 * 「上から評価して最初に真になったものが勝つ」という決まりを、
 * 制御構造ではなく配列の順序で表す。
 */
const RULES: ReadonlyArray<(facts: Facts) => Derivation | null> = [
  // 1. merged — archive されたか、MR がマージされたか
  ({ openspec }) =>
    openspec?.archived === true
      ? {
          stage: 'merged',
          reason: `openspec/changes/archive/${openspec.archivedAs ?? openspec.name} に移動済み`,
        }
      : null,

  ({ mr }) =>
    mr?.state === 'merged' ? { stage: 'merged', reason: `MR !${mr.iid} がマージ済み` } : null,

  // 2. pr — MR が出ている。レビュー後の修正 push はバッジで示す
  ({ mr }) =>
    mr?.state === 'opened'
      ? {
          stage: 'pr',
          reason: hasFixAfterReview(mr)
            ? `MR !${mr.iid} にレビュー後の修正コミットあり（再レビュー待ち）`
            : `MR !${mr.iid} がオープン`,
        }
      : null,

  // 3. impling
  ({ gates }) =>
    gates.plan === 'approved' ? { stage: 'impling', reason: '計画が承認されている' } : null,

  // 4. plan-review — 成果物があることを正とし、ログの欠落で人待ちを取りこぼさない
  ({ gates, openspec }) =>
    openspec?.artifacts.proposal === true && (gates.plan === 'none' || gates.plan === 'submitted')
      ? {
          stage: 'plan-review',
          reason: `openspec/changes/${openspec.name}/proposal.md が人の承認を待っている`,
        }
      : null,

  // 5. planning — 人が着手を指示した。ここが人の列の上限になる
  ({ card }) =>
    card.startedAt !== null
      ? { stage: 'planning', reason: `${card.startedAt} に着手が指示されている` }
      : null,
];

/** 6. idea — どのルールにも当てはまらなかったとき */
const DEFAULT_DERIVATION: Derivation = {
  stage: 'idea',
  reason: 'まだ着手が指示されていない',
};

function deriveStage(facts: Facts): Derivation {
  for (const rule of RULES) {
    const derivation = rule(facts);
    if (derivation !== null) {
      return derivation;
    }
  }

  return DEFAULT_DERIVATION;
}

/**
 * 「AI が指摘を受けて修正を push した」か。
 *
 * レビューコメントが 1 件も無い新規 MR では成立しない。
 * 新しいコメントが来れば日時が逆転し、自然に false へ戻る。
 *
 * かつては `ai-pr-fixed` 列を立てていたが、いまは `pr` 列内のバッジに使う。
 */
export function hasFixAfterReview(mr: MrState): boolean {
  if (mr.latestNoteAt === null || mr.latestCommitAt === null) {
    return false;
  }

  const noteMs = Date.parse(mr.latestNoteAt);
  const commitMs = Date.parse(mr.latestCommitAt);

  if (Number.isNaN(noteMs) || Number.isNaN(commitMs)) {
    return false;
  }

  return commitMs > noteMs;
}
