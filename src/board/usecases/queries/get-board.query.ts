import { ok, err, type Result } from '../../../shared/result.js';
import type { CardRepository } from '../../../cards/repositories/card.repository.js';
import type { OpenSpecRepository } from '../../repositories/openspec.repository.js';
import type { MrStateProvider } from '../../services/mr-state-provider.js';
import { droppableStages, resolveFloorStage, resolveStage } from '../../services/stage-resolver.js';
import {
  toBoardCard,
  type Board,
  type BoardCard,
  type BoardCardMr,
  type BoardCardOpenSpec,
} from '../../models/board-card.js';
import type { OpenSpecChangeState } from '../../models/openspec-state.js';
import type { MrState } from '../../models/mr-state.js';
import type { GetBoardError } from '../../errors/board-errors.js';

// ============================================================
// ボード取得ユースケース
// ============================================================

export type GetBoardQuery = () => Promise<Result<Board, GetBoardError>>;

/**
 * カード・openspec・GitLab の 3 ソースを束ねてボードを組み立てる。
 *
 * ステージ導出そのものは `resolveStage`（純関数）に委譲し、
 * ここは I/O と組み立てだけを担当する。
 */
export function createGetBoardQuery(
  cardRepository: CardRepository,
  openspecRepository: OpenSpecRepository,
  mrProvider: MrStateProvider
): GetBoardQuery {
  return async () => {
    let cards;
    let openspecState;

    try {
      [cards, openspecState] = await Promise.all([
        cardRepository.findAll(),
        openspecRepository.load(),
      ]);
    } catch (error) {
      return err({
        type: 'BoardUnreadable',
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const linkedChanges = new Set<string>();

    const boardCards: BoardCard[] = cards.map((card) => {
      const openspec = card.change === null ? null : (openspecState.get(card.change) ?? null);
      const mr = mrProvider.get(card.id);

      if (openspec !== null) {
        linkedChanges.add(openspec.name);
      }

      const floorStage = resolveFloorStage(card, openspec, mr);

      return toBoardCard(
        card,
        resolveStage(card, openspec, mr),
        { floorStage, droppableStages: droppableStages(floorStage) },
        toBoardCardOpenSpec(openspec),
        toBoardCardMr(mr)
      );
    });

    // どのカードにも紐付いていない change は、紐付け漏れか
    // ボードの外で作られた change。UI で気付けるように返す。
    const orphanChanges = [...openspecState.keys()].filter((name) => !linkedChanges.has(name));

    return ok({
      cards: boardCards,
      gitlab: mrProvider.connection(),
      orphanChanges: orphanChanges.sort(),
      generatedAt: new Date().toISOString(),
    });
  };
}

function toBoardCardOpenSpec(state: OpenSpecChangeState | null): BoardCardOpenSpec | null {
  if (state === null) return null;

  return {
    change: state.name,
    artifacts: state.artifacts,
    tasks: state.tasks,
    archived: state.archived,
    archivedAs: state.archivedAs,
  };
}

function toBoardCardMr(mr: MrState | null): BoardCardMr | null {
  if (mr === null) return null;

  return {
    iid: mr.iid,
    state: mr.state,
    title: mr.title,
    webUrl: mr.webUrl,
    noteCount: mr.noteCount,
    latestNoteAt: mr.latestNoteAt,
    latestCommitAt: mr.latestCommitAt,
  };
}
