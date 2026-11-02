import type { CardRepository } from '../cards/repositories/card.repository.js';
import type { IdeaDividerRepository } from '../cards/repositories/idea-divider.repository.js';
import type { ForgeConfig } from '../shared/config.js';
import type { CliRunner } from '../infrastructure/cli-runner.js';
import { ForgePoller, type ForgePollerOptions } from '../infrastructure/forge-poller.js';
import type { ForgeClient } from './services/forge-client.js';
import { GhForgeClient } from './services/github-client.js';
import { FsPlanRepository, type PlanRepository } from './repositories/plan.repository.js';
import type { MrSnapshotRepository } from './repositories/mr-snapshot.repository.js';
import { FileMrSnapshotRepository } from './repositories/file-mr-snapshot.repository.js';
import {
  GitBranchPlanRepository,
  type BranchPlanRepository,
} from './repositories/branch-plan.repository.js';
import type { DataStore } from '../infrastructure/data-store.js';
import {
  disabledMrStateProvider,
  unavailableMrStateProvider,
  type MrStateProvider,
} from './services/mr-state-provider.js';
import { createGetBoardQuery, type GetBoardQuery } from './usecases/queries/get-board.query.js';
import {
  createFileLoopHistoryRepository,
  type LoopHistoryRepository,
} from './repositories/loop-history.repository.js';

// ============================================================
// Board コンテキスト 依存性構成
// ============================================================

export interface BoardDependencies {
  readonly planRepository: PlanRepository;
  readonly getBoardQuery: GetBoardQuery;
}

/** ループの 1 手の記録が無いことにする読み手。記録を読まない組み立て（テストなど）の既定 */
export const emptyLoopHistoryRepository: LoopHistoryRepository = {
  findAll: () => Promise.resolve([]),
};

export function createBoardDependencies(
  plansDir: string,
  cardRepository: CardRepository,
  ideaDividerRepository: IdeaDividerRepository,
  mrProvider: MrStateProvider = disabledMrStateProvider,
  loopHistoryRepository: LoopHistoryRepository = emptyLoopHistoryRepository
): BoardDependencies {
  const planRepository = new FsPlanRepository(plansDir);

  return {
    planRepository,
    getBoardQuery: createGetBoardQuery(
      cardRepository,
      ideaDividerRepository,
      planRepository,
      mrProvider,
      loopHistoryRepository
    ),
  };
}

/** データのワークツリーの `loop/` から 1 手の記録を読む */
export function createLoopHistoryRepository(dataDir: string): LoopHistoryRepository {
  return createFileLoopHistoryRepository(dataDir);
}

export function createForgeClient(forge: ForgeConfig, runner: CliRunner): ForgeClient {
  return new GhForgeClient(forge, runner);
}

export interface MrStateSource {
  readonly provider: MrStateProvider;
  /** 問い合わせられるときだけ作る。サーバは `start()`、`ai-board status` は `refresh()` を 1 回だけ呼ぶ */
  readonly poller: ForgePoller | null;
}

/** マージ済みの控えはデータ用ブランチに、それ以外は `<dataDir の親>/cache/` に置く */
export function createFileMrSnapshotRepository(store: DataStore): MrSnapshotRepository {
  return new FileMrSnapshotRepository(store);
}

/** カードのブランチの計画を `git -C <repoRoot> show` で読む。`ai-board status` の `next.step` だけに使う */
export function createBranchPlanRepository(
  runner: CliRunner,
  repoRoot: string
): BranchPlanRepository {
  return new GitBranchPlanRepository(runner, repoRoot);
}

/**
 * レビュー要求の状態の供給元を組み立てる。サーバと `ai-board status` で共有する。
 *
 * CLI の有無とログイン状態はここで 1 度だけ確かめる。
 * 1 分ごとに確認するほど頻繁に変わるものではない。
 */
export async function createMrStateSource(
  forge: ForgeConfig | null,
  cardRepository: CardRepository,
  snapshotRepository: MrSnapshotRepository,
  runner: CliRunner,
  options: ForgePollerOptions = {}
): Promise<MrStateSource> {
  if (forge === null) {
    return { provider: disabledMrStateProvider, poller: null };
  }

  const client = createForgeClient(forge, runner);
  const unavailable = await client.checkAuth();

  if (unavailable !== null) {
    return { provider: unavailableMrStateProvider(forge.kind, unavailable), poller: null };
  }

  const poller = new ForgePoller(cardRepository, client, snapshotRepository, options);
  return { provider: poller, poller };
}
