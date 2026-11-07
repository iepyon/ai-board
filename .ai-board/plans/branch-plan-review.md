# GitHub が未設定のボードで、ブランチの計画から計画レビューを立てる

## 人に判断してほしいこと

- **手順書の版を上げるか。** 未設定のボードで、ループの計画の手が push と Draft の PR を飛ばし、`rules.md` のワークツリーへの入り方も変わる。`.claude/HARNESS_VERSIONS.md` に v7 を足す。既定: 上げる
  - → 回答（2026-11-07、plan 承認）: 手順書の版は v7 に上げる
- **未設定のボードで、ワークツリーへの入り方（`rules.md`）も直すか。** 今の `plan` の手は `git fetch origin` して `origin/main` からブランチを切り、`revise-plan` は `git pull --ff-only` する。GitHub に届かない研修ではここで止まる。
  既定: 直す。未設定のボードでは fetch / pull をせず、手元の `main` から切る（`### Non-Goals`・`### 仮定`）
  - → 回答（2026-11-07、plan 承認）: 未設定のボードでは fetch / pull も飛ばすよう rules.md を直す
- **ブランチの計画を読むのは未設定のボードだけにするか。** 既定: する（`### 退けた代案`）
  - → 回答（2026-11-07、チャット）: 未設定のときだけ
- **ループの計画の手（`plan.md`）をこのカードで直すか。** 既定: 直す。未設定のボードでは push と Draft の PR を飛ばし、コミット → `card branch` → `card submit` だけにする
  - → 回答（2026-11-07、チャット）: このカードで直す
- **承認の後の実装の手と、PR の無いボードでのマージ済みの判定を外すか。** 既定: 外す（`unset-impl-close`）（`### Non-Goals`）
  - → 回答（2026-11-07、チャット）: 別のカードにする

## 提案

### Why

研修はオフライン（GitHub に届かない環境）を前提に回せるようにしたい。研修の fork では `config.yaml` に `github:` を書かない（未設定）。
`forge-unset-decide`（#96）で、未設定のボードでも人の判断と次の一手が出るようになった。ただ、計画レビューの列はまだ立たない。

- 計画はカードのブランチにコミットされ、ボードを動かすメインのチェックアウトからは見えない。今は Draft の PR を計画の成果物として計画レビューを立てている（ADR 0004）
- 未設定のボードには PR が無いので、提出しても 計画提案中 のままで判断待ちに出ない
- そもそもループの計画の手は `git push` と `ai-board pr create` を走らせるので、未設定のボード（研修ではオフライン）では提出まで届かない

計画ファイルは手元のブランチにあるので、それを読めば PR が無くても計画レビューを立てられる。

### What Changes

使う人から見た変化は次のとおり（どれも `config.yaml` に `github:` が無いボードだけ）。

- AI が計画を提出すると、カードが 計画レビュー の列に出て、判断待ち（`status` の `waiting`）に「承認 / 差し戻す / 中止する」が出る。`decide approve` で 実装中 へ進む
- ループの計画の手は、計画をコミットしたら push と Draft の PR を飛ばし、ブランチの紐付けと提出だけをする。差し戻された計画を直す手も push しない
- ループがワークツリーに入るとき、`git fetch` / `git pull` をせず、手元の `main` からブランチを切る
- 接続済みのボード、`github:` を書いたまま使えない / エラーのボードは、何も変わらない

### Impact

- ブランチの計画の読み取り: `src/board/repositories/branch-plan.repository.ts`（計画レビューに使う形で読む口）
- 読むカードの選び方: `src/board/services/branch-plan-target.ts`（新規、純関数）
- ボードの組み立て: `src/board/usecases/queries/get-board.query.ts`、`src/board/composition.ts`
- 手順書: `.claude/skills/board-loop/plan.md`・`rules.md`・`SKILL.md`、`.claude/HARNESS_VERSIONS.md`
- ドキュメント: `docs/adr/0004-plans-in-draft-pr.md`、`docs/architecture.md`、`docs/specs/board-stages/spec.md`、`README.md`
- ステージの導出（`stage-resolver.ts`）・データ用ブランチの形の版・GitHub への問い合わせ: 変わらない

## 設計

### Decisions

#### ブランチの計画を `PlanDoc` として読む口

- `BranchPlanRepository` に `findActive(cardId, branch): Promise<PlanDoc | null>` を足す。読むのはブランチの `.ai-board/plans/<id>.md` だけで、`plans/archive/` は読まない
  - ブランチ名の検査と参照の解決（`check-ref-format --branch`、`refs/heads/` → `refs/remotes/origin/`）は今の `find` と同じものを使う
  - `tasks` は本文から `countTasks`（`plan.repository.ts`）で数える。`archived` は常に false
  - `updatedAt` は、その参照で計画ファイルを最後に変えたコミットの時刻（`git log -1 --format=%cI <ref> -- <path>`）。読めなければ null を返す
  - 読めない（ブランチが無い、ファイルが無い、git が失敗した）ときは例外を投げず null を返す
- 今の `find`（`next.step` を決める）は変えない

#### 読むカードを選ぶ純関数

- `src/board/services/branch-plan-target.ts` に `needsBranchPlan(input): boolean` を置く。次をすべて満たすときだけ真
  - GitHub が未設定（`isForgeUnset`）
  - 中止していない、着手済み（`startedAt` が非 null）、`branch` が非 null
  - メインのチェックアウトに計画が無い（`plan` が null。archive も含む）
  - plan ゲートが `none` か `submitted`（ステージの規則 4 が見るのと同じ。`gateStates` で出す）
- 規則 4 に効くカードだけを読み、git を走らせる回数を抑える

#### ボードの組み立てでメインの計画に重ねる

- `createGetBoardQuery` に省略できる引数 `branchPlanRepository` を足す。渡されたときだけ、`needsBranchPlan` が真のカードについて `findActive` を読み、
  その結果をメインの計画（`planState`）が無いところにだけ重ねてから `resolveStage` に渡す。読むカードは `Promise.all` でまとめて読む
- メインのチェックアウトの計画があれば、そちらを使う（重ねない）
- `createBoardDependencies` と `assembleBoard` は、`createBranchPlanRepository(runner, config.paths.root)` を `createGetBoardQuery` に渡す。`status` と `decide` は同じボードを読むので、計画レビューに出たカードを `decide approve` できる
- ステージの規則 4 の理由の文（`.ai-board/plans/<id>.md が人の承認を待っている`）はそのまま使う

#### ループの手順書

- `plan.md` の 4: `status --json --only forge` が未設定（`status` が `disabled` で `kind` が null）なら、コミットまでで止め、push と `ai-board pr create` をしない。続く 5（`card branch` → `card submit`）はそのまま行う。人に伝える「人が見るもの」は PR の URL の代わりにブランチ名と計画ファイルの場所にする
- `plan.md` の `revise-plan`（3 の 2）: 未設定なら push しない
- `rules.md` の「ワークツリーに入る」: 未設定なら、`plan` の手で `git fetch origin` をせず手元の `main` から切り（`git worktree add -b <id> … main`）、それ以外の手で `git pull --ff-only` をしない。「push」とだけ書いたところも未設定なら飛ばすことを添える
- `SKILL.md` の手の表の `plan` の行と、止まる条件の「計画を提出したのに、計画ファイルも Draft の PR も見えない」に、未設定のボードではブランチの計画を見ることを添える
- `.claude/HARNESS_VERSIONS.md` に v7 を足す

#### ドキュメント

- `docs/adr/0004-plans-in-draft-pr.md` の決定に「未設定のボードでは、Draft の PR の代わりにカードのブランチの計画（`plans/<id>.md` だけ）で計画レビューを立てる。ブランチの `archive/` は読まない」を足し、日付に改訂を足す。退けた案に「ブランチの archive も読む」と「接続済みのボードでもブランチを読む」を足す
- `docs/specs/board-stages/spec.md` に、未設定のボードで提出したカードが計画レビューに出るシナリオを足す
- `docs/architecture.md` と `README.md` の計画レビューの説明に、未設定のボードではブランチの計画を読むことを足す

### 仮定

- **ブランチの `archive/` は読まない。** ステージの規則 1（計画が archive 済み → マージ済み）は規則 2（PR中）より上にある。実装の締めはブランチで計画を archive してから Ready にするので、
  ブランチの archive を読むと PR中 のカードがマージ前にマージ済みに見える（探索メモ）。未設定のボードの締めは `unset-impl-close` で決める
- **読むのは規則 4 に効くカードだけ。** 承認済みのカード（実装中）は規則 3 で列が決まり、ブランチの計画は要らない。段（`next.step`）は今どおり `find` で読む
- **ローカルのブランチを先に読む。** 未設定のボードでは push しないので、ブランチはローカルにしか無い。今の `find` と同じ順（`refs/heads/` → `refs/remotes/origin/`）で足りる
- **`updatedAt` はコミットの時刻にする。** メインの計画は mtime だが、ブランチのファイルには mtime が無い。「しばらく動きが無い」の目安には、計画を最後に変えたコミットで足りる
- **未設定かは `status --json --only forge` で読む。** 手順書は `forge.status` が `disabled` で `kind` が null のときを未設定とする（`isForgeUnset` と同じ見分け）
- **未設定のボードでは `git fetch` / `git pull` を飛ばす。** `github:` が無くても `origin` に届くことはあるが、未設定のボードは push しないので `origin` のブランチを読む理由が無く、届かない研修では fetch で止まる（人に判断してほしいこと）
- **提出済みなのに成果物が見えない止まり（`planLost`）は、未設定のボードでは今どおり立たない。** `mrKnown` が偽のままなので変えない。ブランチの計画を読めれば計画レビューに出るので、止まりは要らない

### 退けた代案

- **接続済みのボードでもブランチの計画を読む:** Draft の PR を出す前の、計画をコミットした時点で計画レビューが立ち、`status` のたびに git を数回走らせる（人の答え、2026-11-07）（人に判断してほしいこと）
- **使えません / エラーのボードでもブランチの計画を読む:** そのボードでは `decide` が判断を拒むので、計画レビューに出ても承認できない。手元の控えで描くのは `offline-snapshot-view` の範囲（人の答え、2026-11-07）
- **ブランチの `archive/` も読む:** PR中 のカードがマージ前にマージ済みに見える（仮定）
- **`PlanRepository.load()` の中でブランチを読む:** `load()` はカードの一覧を受けないので、読むカードを絞れない。ボードの組み立てでカードと一緒に決める
- **`stage-resolver.ts` にブランチの計画の規則を足す:** 導出の核は変えない。渡す計画の出どころを広げるだけにする（カードのアイデア）
- **計画の手で `git push` だけはする:** 研修は GitHub に届かないので push で止まる。未設定のボードは手元のブランチで完結させる

### Risks / Trade-offs

- 計画の手がコミットしてから提出するまでの間も、計画ファイルがあれば計画レビューに見える（規則 4 は plan ゲートが `none` でも立つ）。同じ手の中なので、`status` を読むのは提出の後になる
- 読むカードが増えると `status` / `decide` が遅くなる。1 枚につき git を 4 回ほど走らせる。対象は計画提案中 / 計画レビューのカードだけなので、研修では数枚にとどまる
- 未設定のボードでは計画の本文を PR で読めない。人は `git show <branch>:.ai-board/plans/<id>.md` か、ワークツリーのファイルで読む。手順書の「人に伝える」にブランチ名と計画ファイルの場所を出す
- このカードだけでは、承認の後の実装の手は節ごとの push と締めの `pr` コマンドで止まる（`unset-impl-close`）

### Non-Goals

- 承認の後の実装の手（節ごとの push、締めの `pr checks` / `pr edit` / `pr ready`）と、PR の無いボードでのマージ済みの判定（`unset-impl-close`）（人に判断してほしいこと）
- 使えません / エラーのボードの扱い（`offline-snapshot-view`）
- 計画の本文をボードに出すこと
- ステージの導出の変更

## 探索メモとの対応

| #   | 探索メモ（短い引用）                                                                                           | 反映した先                                                            | 反映しなかった理由 |
| --- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------ |
| 1   | ステージの規則 4 は「計画ファイルか Draft の PR があり、plan ゲートが none / submitted」。計画はメインから読む | Decisions（読むカードを選ぶ純関数）                                   |                    |
| 2   | 計画で決めること: 全カードのブランチを毎回読むと遅くならないか                                                 | Decisions（読むカードを選ぶ純関数）・Risks / Trade-offs               |                    |
| 3   | 計画で決めること: ブランチの計画が archive に移されたとき（マージ済みの判定）とのかみ合わせ                    | 仮定（ブランチの `archive/` は読まない）・退けた代案                  |                    |
| 4   | 計画で決めること: オンラインのときも同じ読み方にするか                                                         | 退けた代案・人に判断してほしいこと                                    |                    |
| 5   | PR中 の列はオフラインでは立たない。研修で要るかは別に決める                                                    | Non-Goals（`unset-impl-close`）                                       |                    |
| 6   | ブランチの archive は読まない（規則 1 で PR中 がマージ済みに見える）                                           | 仮定・Decisions（ブランチの計画を `PlanDoc` として読む口）            |                    |
| 7   | 読むカードは絞れる。`find` は 1 枚につき数回の git                                                             | Decisions（読むカードを選ぶ純関数）・Risks / Trade-offs               |                    |
| 8   | `PlanRepository.load()` はカードの一覧を受けない。`updatedAt` は mtime なのでコミットの時刻などで代える        | Decisions（ボードの組み立てでメインの計画に重ねる）・仮定・退けた代案 |                    |
| 9   | 未設定のボードの計画の手は push と `ai-board pr create` で失敗し、提出まで届かない                             | Decisions（ループの手順書）                                           |                    |
| 10  | 使えません のボードは判断を拒むので、計画レビューに出ても承認は書けない                                        | 退けた代案                                                            |                    |
| 11  | 承認の後の実装の手も、未設定のボードでは止まる                                                                 | Non-Goals・Risks / Trade-offs                                         |                    |
| 12  | 人の答え: ブランチの計画で計画レビューを立てるのは未設定のボードのときだけ                                     | Decisions・退けた代案・人に判断してほしいこと                         |                    |
| 13  | 人の答え: 計画の手（`plan.md`）をこのカードで直す                                                              | Decisions（ループの手順書）・人に判断してほしいこと                   |                    |
| 14  | 人の答え: 実装の手とマージ済みの判定は別のカードにする                                                         | Non-Goals・人に判断してほしいこと                                     |                    |

## 動作確認の手順

ワークツリーは `$MAIN/.claude/worktrees/branch-plan-review`（以下 `$WT`）。`rules.md` の「動かして確かめるとき」のとおり、スクラッチパッドの bare リポジトリを `origin` にした clone（`$S/data`）を `AI_BOARD_DATA` で指す。
計画とカードのブランチを置くために、空の git リポジトリ `$S/repo` を作り、`--root $S/repo` で走らせる。`config.yaml` は置かない（未設定）。以下 `B` は `AI_BOARD_DATA=$S/data node $WT/dist/cli.js` と `--root $S/repo` を付けて走らせることを指す。

1. ブランチの計画を提出すると計画レビューに出る
   - コマンド: `B card create --id alpha …` → `B decide start alpha`。`$S/repo` で `git switch -c alpha` して `.ai-board/plans/alpha.md` をコミットし、`main` に戻る。`B card branch alpha alpha` → `B card submit alpha --reason なし` → `B status --json --only waiting`
   - 期待: `waiting` に `alpha` が `stage: plan-review` で出て、`decisions` に承認 / 差し戻し / 中止がある
2. 計画レビューに出たカードを承認できる
   - コマンド: `B decide approve alpha`
   - 期待: `alpha: plan 承認 を書きました（計画レビュー → 実装中）`
3. ブランチの archive は読まない
   - コマンド: カード `beta` を同じく着手してブランチ `beta` を紐付け、ブランチには `.ai-board/plans/archive/beta.md` だけをコミットして提出し、`B status --json --only cards.id,cards.stage`
   - 期待: `beta` は `planning`（マージ済みにならない）
4. `github:` があるボードではブランチを読まない
   - コマンド: `$S/repo/.ai-board/config.yaml` に `github:`（`repository: 'example/none'`）を書き、`gh` の無い `PATH` で 1 の `status --json --only cards.id,cards.stage`
   - 期待: `alpha` 相当の提出済みカードは計画レビューにならない（今どおり）
5. 未設定のボードでループの計画の手が push と PR を飛ばして提出まで進む（共有のカードと手順書を使うので AI は走らせていない。人が研修の fork で確かめる）
   - コマンド: 研修の fork で `github:` を消してカードに着手し、`/board-loop`
   - 期待: 計画の手が push と `ai-board pr create` をせずに提出し、カードが判断待ちに 計画レビュー で出る

## タスク

### 1. ブランチの計画を読み、ボードに重ねる

- [x] `src/board/repositories/branch-plan.repository.ts` に `findActive` を足す（`plans/<id>.md` だけ、`countTasks`、コミットの時刻）
- [x] `src/board/services/branch-plan-target.ts` に `needsBranchPlan` を置く
- [x] `src/board/usecases/queries/get-board.query.ts` で、`needsBranchPlan` が真のカードのブランチの計画を読み、メインの計画が無いところに重ねる
- [x] `src/board/composition.ts` の `createBoardDependencies` / `assembleBoard` で `branchPlanRepository` を渡す
- [x] テスト: `findActive`（一時の git リポジトリで、active を読む・archive を読まない・不正なブランチ名で null）、`needsBranchPlan`（各条件）、`get-board.query`（未設定なら計画レビュー、接続済みなら読まない、メインの計画を優先）、`decide-cli`（未設定のボードでブランチの計画のカードを承認できる）

### 2. ループの手順書とドキュメント

- [ ] `.claude/skills/board-loop/plan.md` の 4 と `revise-plan` を、未設定のボードでは push と Draft の PR を飛ばす形に直す
- [ ] `.claude/skills/board-loop/rules.md` の「ワークツリーに入る」と push の決まりを、未設定のボードでは fetch / pull / push をしない形に直し、`SKILL.md` の表と止まる条件に添える
- [ ] `docs/adr/0004-plans-in-draft-pr.md` を書き直し（`adr` のスキル）、`docs/specs/board-stages/spec.md`・`docs/architecture.md`・`README.md` を直す
- [ ] `.claude/HARNESS_VERSIONS.md` に v7 を足す（人の判断で上げないなら、このタスクを外す）
