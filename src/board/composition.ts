import type { CardRepository } from '../cards/repositories/card.repository.js';
import type { IdeaDividerRepository } from '../cards/repositories/idea-divider.repository.js';
import type { ForgeConfig } from '../shared/config.js';
import type { CliRunner } from '../infrastructure/cli-runner.js';
import type { ForgeClient } from './services/forge-client.js';
import { GhForgeClient } from './services/github-client.js';
import { FsPlanRepository, type PlanRepository } from './repositories/plan.repository.js';
import { disabledMrStateProvider, type MrStateProvider } from './services/mr-state-provider.js';
import { createGetBoardQuery, type GetBoardQuery } from './usecases/queries/get-board.query.js';
import { createGetPlanQuery, type GetPlanQuery } from './usecases/queries/get-plan.query.js';

// ============================================================
// Board コンテキスト 依存性構成
// ============================================================

export interface BoardDependencies {
  readonly planRepository: PlanRepository;
  readonly getBoardQuery: GetBoardQuery;
  readonly getPlanQuery: GetPlanQuery;
}

export function createBoardDependencies(
  plansDir: string,
  cardRepository: CardRepository,
  ideaDividerRepository: IdeaDividerRepository,
  mrProvider: MrStateProvider = disabledMrStateProvider
): BoardDependencies {
  const planRepository = new FsPlanRepository(plansDir);

  return {
    planRepository,
    getBoardQuery: createGetBoardQuery(
      cardRepository,
      ideaDividerRepository,
      planRepository,
      mrProvider
    ),
    getPlanQuery: createGetPlanQuery(planRepository),
  };
}

export function createForgeClient(forge: ForgeConfig, runner: CliRunner): ForgeClient {
  return new GhForgeClient(forge, runner);
}
