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
 *   （`needsBranchPlan` が選んだカードだけ。`archive/` は読まない）
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
}

const PLANS_DIR = '.ai-board/plans';
const ARCHIVE_DIR = `${PLANS_DIR}/archive`;

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
    if (!(await this.isValidBranchName(branch))) return null;

    const ref = await this.resolveRef(branch);
    if (ref === null) return null;

    const active = await this.git(['show', '--no-textconv', `${ref}:${PLANS_DIR}/${cardId}.md`]);
    if (active !== null) return { location: 'active', text: active };

    const archived = await this.git([
      'show',
      '--no-textconv',
      `${ref}:${ARCHIVE_DIR}/${cardId}.md`,
    ]);
    if (archived !== null) return { location: 'archived' };

    return null;
  }

  async findActive(cardId: CardId, branch: string): Promise<PlanDoc | null> {
    if (!(await this.isValidBranchName(branch))) return null;

    const ref = await this.resolveRef(branch);
    if (ref === null) return null;

    const file = `${PLANS_DIR}/${cardId}.md`;
    const text = await this.git(['show', '--no-textconv', `${ref}:${file}`]);
    if (text === null) return null;

    const committedAt = (await this.git(['log', '-1', '--format=%cI', ref, '--', file]))?.trim();
    if (committedAt === undefined || committedAt === '') return null;

    return {
      cardId,
      tasks: countTasks(text),
      archived: false,
      updatedAt: new Date(committedAt).toISOString(),
    };
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
