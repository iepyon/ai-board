import type { CardRepository } from '../cards/repositories/card.repository.js';
import {
  FsOpenSpecRepository,
  type OpenSpecRepository,
} from './repositories/openspec.repository.js';
import { disabledMrStateProvider, type MrStateProvider } from './services/mr-state-provider.js';
import { createGetBoardQuery, type GetBoardQuery } from './usecases/queries/get-board.query.js';

// ============================================================
// Board コンテキスト 依存性構成
// ============================================================

export interface BoardDependencies {
  readonly openspecRepository: OpenSpecRepository;
  readonly getBoardQuery: GetBoardQuery;
}

export function createBoardDependencies(
  openspecDir: string,
  cardRepository: CardRepository,
  mrProvider: MrStateProvider = disabledMrStateProvider
): BoardDependencies {
  const openspecRepository = new FsOpenSpecRepository(openspecDir);

  return {
    openspecRepository,
    getBoardQuery: createGetBoardQuery(cardRepository, openspecRepository, mrProvider),
  };
}
