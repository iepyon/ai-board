import { stageRank, type Stage } from '../../shared/schemas/common.js';
import type { Card } from '../../cards/models/card.js';
import type { OpenSpecChangeState } from '../models/openspec-state.js';
import type { MrState } from '../models/mr-state.js';

// ============================================================
// ステージ導出 — このプロジェクトの核
// ============================================================

/**
 * 人が直接動かせるステージ。
 *
 * いずれもカードファイルのフラグ（`explored` / `implStartedAt`）で決まる。
 * 残りの proposed / ai-pr / ai-pr-fixed / done は openspec と GitLab の
 * 実態から導出されるため、人が手で置いても実態は変わらない＝AI の領分。
 */
export const HUMAN_STAGES = ['idea', 'explored', 'impling'] as const satisfies readonly Stage[];

export interface StageResolution {
  /** 実際に表示する列。手動上書きがあればそれ、無ければ derived */
  readonly stage: Stage;
  /** 実態から自動導出したステージ */
  readonly derived: Stage;
  /** stageOverride が設定されているか */
  readonly overridden: boolean;
  /** 手動上書きと自動導出が食い違っているか（UI で警告バッジを出す） */
  readonly diverged: boolean;
  /** derived がその値になった理由。UI のツールチップに出す */
  readonly reason: string;
}

/**
 * カードのステージを決める純関数。副作用なし。
 *
 * 自動導出は下記を上から評価し、最初に真になったものを採用する
 * （＝最も進んだステージ）。`card.stageOverride` があればそれを最優先。
 *
 * | # | stage       | 条件                                                        |
 * |---|-------------|-------------------------------------------------------------|
 * | 1 | done        | archive に存在、または MR が merged                          |
 * | 2 | ai-pr-fixed | MR opened かつ 最新コミット > 最新レビューコメント            |
 * | 3 | ai-pr       | MR が存在し opened                                           |
 * | 4 | impling     | implStartedAt が非 null                                      |
 * | 5 | proposed    | openspec の proposal.md が存在                               |
 * | 6 | explored    | explored フラグが true                                       |
 * | 7 | idea        | 既定                                                         |
 */
export function resolveStage(
  card: Card,
  openspec: OpenSpecChangeState | null,
  mr: MrState | null
): StageResolution {
  const { stage: derived, reason } = deriveStage(card, openspec, mr);

  if (card.stageOverride === null) {
    return { stage: derived, derived, overridden: false, diverged: false, reason };
  }

  return {
    stage: card.stageOverride,
    derived,
    overridden: true,
    diverged: card.stageOverride !== derived,
    reason,
  };
}

/**
 * カードのフラグをすべて外したときに残るステージ＝AI の成果物が課す下限。
 *
 * `proposal.md` があれば proposed より前には戻せないし、MR があれば
 * 人はもう動かせない。導出ルールを二重に持たないよう、フラグを落とした
 * カードで同じ `deriveStage` を呼ぶ。
 */
export function resolveFloorStage(
  card: Card,
  openspec: OpenSpecChangeState | null,
  mr: MrState | null
): Stage {
  return deriveStage({ ...card, explored: false, implStartedAt: null }, openspec, mr).stage;
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

/** 判定に必要な 3 ソースをまとめたもの */
interface Facts {
  readonly card: Card;
  readonly openspec: OpenSpecChangeState | null;
  readonly mr: MrState | null;
}

/**
 * 進んだステージから順に並べたルール。最初に非 null を返したものが採用される。
 *
 * 「上から評価して最初に真になったものが勝つ」という決まりを、
 * 制御構造ではなく配列の順序で表す。
 */
const RULES: ReadonlyArray<(facts: Facts) => Derivation | null> = [
  // 1. done — archive されたか、MR がマージされたか
  ({ openspec }) =>
    openspec?.archived === true
      ? {
          stage: 'done',
          reason: `openspec/changes/archive/${openspec.archivedAs ?? openspec.name} に移動済み`,
        }
      : null,

  ({ mr }) =>
    mr?.state === 'merged' ? { stage: 'done', reason: `MR !${mr.iid} がマージ済み` } : null,

  // 2. ai-pr-fixed — レビュー指摘のあとに修正コミットが push された（＝再レビュー待ち）
  //    GitLab の resolved フラグはレビュアーの操作なので使わない。
  ({ mr }) =>
    mr?.state === 'opened' && hasFixAfterReview(mr)
      ? {
          stage: 'ai-pr-fixed',
          reason: `MR !${mr.iid} にレビュー後の修正コミットあり（再レビュー待ち）`,
        }
      : null,

  // 3. ai-pr
  ({ mr }) =>
    mr?.state === 'opened'
      ? {
          stage: 'ai-pr',
          reason:
            mr.noteCount > 0
              ? `MR !${mr.iid} がオープン（未対応のレビューコメント ${mr.noteCount} 件）`
              : `MR !${mr.iid} がオープン`,
        }
      : null,

  // 4. impling — ファイルからは観測できないため明示マーカーでのみ立つ
  ({ card }) =>
    card.implStartedAt !== null
      ? { stage: 'impling', reason: `${card.implStartedAt} に実装開始が記録されている` }
      : null,

  // 5. proposed
  ({ openspec }) =>
    openspec?.artifacts.proposal === true
      ? { stage: 'proposed', reason: `openspec/changes/${openspec.name}/proposal.md が存在` }
      : null,

  // 6. explored
  ({ card }) =>
    card.explored ? { stage: 'explored', reason: 'explored フラグが立っている' } : null,
];

/** 7. idea — どのルールにも当てはまらなかったとき */
const DEFAULT_DERIVATION: Derivation = {
  stage: 'idea',
  reason: '実態を示す情報がまだない',
};

function deriveStage(
  card: Card,
  openspec: OpenSpecChangeState | null,
  mr: MrState | null
): Derivation {
  const facts: Facts = { card, openspec, mr };

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
 * 新しいコメントが来れば日時が逆転し、自然に ai-pr へ戻る。
 */
function hasFixAfterReview(mr: MrState): boolean {
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
