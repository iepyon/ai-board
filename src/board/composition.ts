import type { CardRepository } from '../cards/repositories/card.repository.js';
import type { ForgeConfig } from '../shared/config.js';
import type { CliRunner } from '../infrastructure/cli-runner.js';
import type { ForgeClient } from './services/forge-client.js';
import { GlabForgeClient } from './services/gitlab-client.js';
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
  mrProvider: MrStateProvider = disabledMrStateProvider
): BoardDependencies {
  const planRepository = new FsPlanRepository(plansDir);

  return {
    planRepository,
    getBoardQuery: createGetBoardQuery(cardRepository, planRepository, mrProvider),
    getPlanQuery: createGetPlanQuery(planRepository),
  };
}

/**
 * 設定に書かれた取得先の実装を選ぶ。
 * 取得先ごとの分岐はこの 1 か所に閉じる。
 */
export function createForgeClient(forge: ForgeConfig, runner: CliRunner): ForgeClient {
  switch (forge.kind) {
    case 'gitlab':
      return new GlabForgeClient(forge, runner);
    case 'github':
      return new GhForgeClient(forge, runner);
  }
}
