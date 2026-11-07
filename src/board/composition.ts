import type { CardRepository } from '../cards/repositories/card.repository.js';
import { createFileCardDependencies, createTransactionalPrWriter } from '../cards/composition.js';
import type { IdeaDividerRepository } from '../cards/repositories/idea-divider.repository.js';
import { loadConfig, type ForgeConfig } from '../infrastructure/config.js';
import type { CliRunner } from '../infrastructure/cli-runner.js';
import { PrFetcher, type PrFetcherOptions } from '../infrastructure/pr-fetcher.js';
import type { ForgeClient } from './services/forge-client.js';
import { GhForgeClient } from './services/github-client.js';
import { FsPlanRepository, type PlanRepository } from './repositories/plan.repository.js';
import type { PrSnapshotRepository } from './repositories/pr-snapshot.repository.js';
import type { PrState } from './models/pr-state.js';
import { FilePrSnapshotRepository } from './repositories/file-pr-snapshot.repository.js';
import {
  emptyBranchPlanRepository,
  GitBranchPlanRepository,
  type BranchPlanRepository,
} from './repositories/branch-plan.repository.js';
import type { DataStore } from '../infrastructure/data-store.js';
import {
  disabledPrStateProvider,
  matchMergedSnapshots,
  unavailablePrStateProvider,
  type PrStateProvider,
} from './services/pr-state-provider.js';
import { createGetBoardQuery, type GetBoardQuery } from './usecases/queries/get-board.query.js';
import { createGetStatusQuery, type GetStatusQuery } from './usecases/queries/get-status.query.js';
import { createDecideCommands, type DecideCommands } from './usecases/commands/decide.command.js';
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
  prProvider: PrStateProvider = disabledPrStateProvider,
  loopHistoryRepository: LoopHistoryRepository = emptyLoopHistoryRepository,
  branchPlanRepository: BranchPlanRepository = emptyBranchPlanRepository
): BoardDependencies {
  const planRepository = new FsPlanRepository(plansDir);

  return {
    planRepository,
    getBoardQuery: createGetBoardQuery(
      cardRepository,
      ideaDividerRepository,
      planRepository,
      prProvider,
      loopHistoryRepository,
      branchPlanRepository
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

export interface PrStateSource {
  readonly provider: PrStateProvider;
  /** 問い合わせられるときだけ作る。CLI は 1 回の実行で `refresh()` を 1 回だけ呼ぶ */
  readonly fetcher: PrFetcher | null;
}

/** マージ済みの控えはデータ用ブランチに、それ以外は `<dataDir の親>/cache/` に置く */
export function createFilePrSnapshotRepository(store: DataStore): PrSnapshotRepository {
  return new FilePrSnapshotRepository(store);
}

/**
 * カードのブランチの計画を `git -C <repoRoot> show` で読む。`ai-board status` の `next.step` と、
 * GitHub が未設定のボードで計画レビューの列を立てるのに使う
 */
export function createBranchPlanRepository(
  runner: CliRunner,
  repoRoot: string
): BranchPlanRepository {
  return new GitBranchPlanRepository(runner, repoRoot);
}

/**
 * レビュー要求の状態の供給元を組み立てる。`ai-board status` と `decide` が使う。
 *
 * CLI の有無とログイン状態はここで 1 度だけ確かめる。
 * 1 分ごとに確認するほど頻繁に変わるものではない。
 *
 * 届かない（CLI が無い・未ログイン・ネットワークが無い）ときは、データ用ブランチのマージ済みの控えのうち、
 * カードの PR 番号と合うものだけを供給元に渡す。マージ前の控え（`cache/`）は古いことがあるので使わない。
 */
export async function createPrStateSource(
  forge: ForgeConfig | null,
  cardRepository: CardRepository,
  snapshotRepository: PrSnapshotRepository,
  runner: CliRunner,
  options: PrFetcherOptions = {}
): Promise<PrStateSource> {
  if (forge === null) {
    return { provider: disabledPrStateProvider, fetcher: null };
  }

  const client = createForgeClient(forge, runner);
  const unavailable = await client.checkAuth();

  if (unavailable !== null) {
    const merged = await readMergedSnapshots(cardRepository, snapshotRepository);
    return { provider: unavailablePrStateProvider(forge.kind, unavailable, merged), fetcher: null };
  }

  const fetcher = new PrFetcher(cardRepository, client, snapshotRepository, options);
  return { provider: fetcher, fetcher };
}

/**
 * 届かないときに出すマージ済みの PR の状態を読む。
 * 読めなければ警告して空にする（すべての PR を null とした前の形に戻るだけで、ボードは落とさない）
 */
async function readMergedSnapshots(
  cardRepository: CardRepository,
  snapshotRepository: PrSnapshotRepository
): Promise<Map<string, PrState>> {
  try {
    const [cards, snapshots] = await Promise.all([
      cardRepository.findAll(),
      snapshotRepository.findMerged(),
    ]);
    return matchMergedSnapshots(cards, snapshots);
  } catch (error) {
    console.warn(
      `[ai-board] マージ済みの PR の控えを読めませんでした: ${error instanceof Error ? error.message : String(error)}`
    );
    return new Map();
  }
}

/** `status` と `decide` が使う、組み立て済みのボード */
export interface AssembledBoard {
  /** ボードの見せる形。`next.step` を、カードのブランチの計画から読む（`git fetch` はしない） */
  readonly getStatusQuery: GetStatusQuery;
  /**
   * 人の判断を書く。ボードの導出・検査・書き込みを `store` の書き込みの 1 操作の中で走らせる。
   * 書き込みの中で導くボードも、頭で 1 回取り直した PR の状態を使い、問い合わせ直さない
   */
  readonly decide: DecideCommands;
}

/**
 * `status` と `decide` が使うボードの組み立て。データ用ブランチは呼び出し側が取り直しておく。
 *
 * PR の状態は`refresh()` を 1 回だけ待ってから読む。
 * `branch` から解決した PR 番号の書き戻しも、この `refresh()` の中で起きる。
 */
export async function assembleBoard(
  root: string,
  store: DataStore,
  runner: CliRunner
): Promise<AssembledBoard> {
  const config = loadConfig(root);
  const cards = createFileCardDependencies(store.dataDir);
  const { provider, fetcher } = await createPrStateSource(
    config.forge,
    cards.cardRepository,
    createFilePrSnapshotRepository(store),
    runner,
    // ブランチから解決した PR 番号は、コミットして push する。ファイルに書くだけでは次の取り直しで捨てられる
    { writePr: createTransactionalPrWriter(store) }
  );
  await fetcher?.refresh();

  const branchPlans = createBranchPlanRepository(runner, config.paths.root);
  const board = createBoardDependencies(
    config.paths.plansDir,
    cards.cardRepository,
    cards.ideaDividerRepository,
    provider,
    createLoopHistoryRepository(store.dataDir),
    branchPlans
  );

  return {
    getStatusQuery: createGetStatusQuery(board.getBoardQuery, branchPlans),
    decide: createDecideCommands({ loadBoard: board.getBoardQuery, store, cards }),
  };
}
