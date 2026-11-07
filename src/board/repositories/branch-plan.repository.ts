import type { CliRunner } from '../../infrastructure/cli-runner.js';
import { isErr } from '../../shared/result.js';
import type { CardId } from '../../shared/schemas/common.js';
import type { ImplStepPlan } from '../services/impl-step.js';
import type { PlanDoc } from '../models/plan-state.js';
import { countTasks } from './plan.repository.js';

// ============================================================
// カードのブランチの計画の読み取り（git show）
// ============================================================

/**
 * カードのブランチにコミットされた計画を読む。
 *
 * - `find`: `status` の CLI が、`next` に選ばれた `implement` の 1 枚の段（`next.step`）を決める
 * - `findActive`: GitHub が未設定のボードで、メインのチェックアウトに無い計画を補い、計画レビューの列を立てる
 *   （`branchPlanTarget` が選んだカードだけ。`archive/` は読まない）
 * - `findClosed`: GitHub が未設定のボードで、実装中のカードの締めが済んだ（ブランチで計画が archive 済み）かを読み、
 *   マージ待ちの止まりを立てる（`branchCloseTarget` が選んだカードだけ。ステージの導出には渡さない）
 *
 * 読めない（ブランチが無い、`git` が失敗した、計画が無い）ときは例外を投げず null を返す。
 * 段が読めなくても、次の一手そのものは読めているので `status` は失敗させない。
 * `git fetch` はしない。ネットワークに出るのは PR の問い合わせだけにする。
 */
export interface BranchPlanRepository {
  /** `branch` の計画を、`plans/` → `plans/archive/` の順に読む。どちらも無ければ null */
  find(cardId: CardId, branch: string): Promise<ImplStepPlan | null>;
  /**
   * `branch` の `plans/<id>.md` を、メインの計画と同じ形（`PlanDoc`）で読む。無ければ null。
   * `archive/` は読まない。読むと、締めで archive して Ready にした PR中 のカードがマージ前にマージ済みに見えるため。
   * `updatedAt` は、その計画ファイルを最後に変えたコミットの時刻
   */
  findActive(cardId: CardId, branch: string): Promise<PlanDoc | null>;
  /**
   * `branch` に `plans/<id>.md` が無く `plans/archive/<id>.md` があるとき（締めの段が計画を archive した）、
   * archive のファイルを最後に変えたコミットの時刻を返す。それ以外は null。
   * 止まりの判定にだけ使い、ステージの導出には渡さない（渡すとマージ前にマージ済みに見える）
   */
  findClosed(cardId: CardId, branch: string): Promise<BranchClosed | null>;
}

/** カードのブランチで締めが済んだこと。`archivedAt` は計画を archive したコミットの時刻 */
export interface BranchClosed {
  readonly archivedAt: string;
}

const PLANS_DIR = '.ai-board/plans';
const ARCHIVE_DIR = `${PLANS_DIR}/archive`;

function activePath(cardId: CardId): string {
  return `${PLANS_DIR}/${cardId}.md`;
}

function archivePath(cardId: CardId): string {
  return `${ARCHIVE_DIR}/${cardId}.md`;
}

/** 何も読まない読み手。ブランチの計画を読まない組み立て（テストなど）の既定 */
export const emptyBranchPlanRepository: BranchPlanRepository = {
  find: () => Promise.resolve(null),
  findActive: () => Promise.resolve(null),
  findClosed: () => Promise.resolve(null),
};

/**
 * `git -C <repoRoot>` で読む。引数は配列で渡し、shell を通さない（`cli-runner.ts`）。
 *
 * カードの `branch` は誰でも書けるので、次の 2 つで守る。
 * - `git check-ref-format --branch` を通らない名前なら、`git show` を呼ばずに null を返す。
 *   `-` で始まる名前は、オプションとして読まれないよう `git` に渡す前に弾く
 * - `refs/heads/` / `refs/remotes/origin/` を前に付けた完全な名前で参照する
 *
 * ローカルのブランチがあればそれを、無ければ `origin` の追跡ブランチを読む。
 * ループは同じリポジトリのワークツリーでコミットするので、
 * ローカルのブランチが最も新しい。クラウドの新しいセッションのように
 * ローカルのブランチが無いときだけ、`origin` の追跡ブランチに頼る。
 */
export class GitBranchPlanRepository implements BranchPlanRepository {
  constructor(
    private readonly runner: CliRunner,
    private readonly repoRoot: string
  ) {}

  async find(cardId: CardId, branch: string): Promise<ImplStepPlan | null> {
    const ref = await this.ref(branch);
    if (ref === null) return null;

    const active = await this.show(ref, activePath(cardId));
    if (active !== null) return { location: 'active', text: active };

    const archived = await this.show(ref, archivePath(cardId));
    if (archived !== null) return { location: 'archived' };

    return null;
  }

  async findActive(cardId: CardId, branch: string): Promise<PlanDoc | null> {
    const ref = await this.ref(branch);
    if (ref === null) return null;

    const file = activePath(cardId);
    const [text, log] = await Promise.all([
      this.show(ref, file),
      this.git(['log', '-1', '--format=%cI', ref, '--', file]),
    ]);
    const committedAt = log?.trim();
    if (text === null || !committedAt) return null;

    return {
      cardId,
      tasks: countTasks(text),
      archived: false,
      updatedAt: new Date(committedAt).toISOString(),
    };
  }

  async findClosed(cardId: CardId, branch: string): Promise<BranchClosed | null> {
    const ref = await this.ref(branch);
    if (ref === null) return null;

    const file = archivePath(cardId);
    const [active, archived, log] = await Promise.all([
      this.show(ref, activePath(cardId)),
      this.show(ref, file),
      this.git(['log', '-1', '--format=%cI', ref, '--', file]),
    ]);
    const committedAt = log?.trim();
    if (active !== null || archived === null || !committedAt) return null;

    return { archivedAt: new Date(committedAt).toISOString() };
  }

  /** 検査を通ったブランチの完全な参照（`refs/heads/…` か `refs/remotes/origin/…`）。通らない・無ければ null */
  private async ref(branch: string): Promise<string | null> {
    return (await this.isValidBranchName(branch)) ? this.resolveRef(branch) : null;
  }

  private show(ref: string, file: string): Promise<string | null> {
    return this.git(['show', '--no-textconv', `${ref}:${file}`]);
  }

  /**
   * `check-ref-format --branch` は `@{-1}` のような書き方を実際のブランチ名に展開して返すので、
   * 返った名前が渡した名前と同じときだけ通す。
   */
  private async isValidBranchName(branch: string): Promise<boolean> {
    if (branch === '' || branch.startsWith('-')) return false;

    const checked = await this.git(['check-ref-format', '--branch', branch]);
    return checked !== null && checked.trim() === branch;
  }

  private async resolveRef(branch: string): Promise<string | null> {
    for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
      if ((await this.git(['rev-parse', '--verify', '--quiet', ref])) !== null) return ref;
    }
    return null;
  }

  private async git(args: readonly string[]): Promise<string | null> {
    const result = await this.runner.run('git', ['-C', this.repoRoot, ...args]);
    return isErr(result) ? null : result.value;
  }
}
