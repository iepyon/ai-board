# GitHub が未設定のボードで、承認した計画を実装からマージ済みまで進める

## 人に判断してほしいこと

- **手順書の版を上げるか。** 未設定のボードで、実装の手が push と締めの `ai-board pr` を飛ばし、`board-reviewer` が PR の代わりにブランチの差分を読むようになる。`.claude/HARNESS_VERSIONS.md` に v8 を足す。既定: 上げる
  - → 回答（2026-11-07、plan 承認）: 理由なしで承認（既定のまま進む）
- **`board-reviewer`（AI レビューの段）もこのカードで直すか。** 今の `board-reviewer` は、カードの `mr` が null なら止まり、PR の差分を読み、push する。直さないと、未設定のボードはタスクを倒した後のレビューの段で止まり、締めの段に届かない。
  既定: 直す。未設定のボードでは `mr` が null でも止まらず、手元の `main` とカードのブランチの差分（`git diff main...<branch>`）を読み、コミットだけして push しない（`### 仮定`）
  - → 回答（2026-11-07、plan 承認）: 理由なしで承認（既定のまま進む）
- **未設定のボードでマージ済みのカードの時刻（区間の時間）を出すか。** PR が無いので、Ready / マージの時刻が無く、ボードの区間（timeline）の締めとマージの点が出ない。既定: このカードでは出さない（`### Non-Goals`）
  - → 回答（2026-11-07、plan 承認）: 理由なしで承認（既定のまま進む）

## 提案

### Why

研修はオフライン（GitHub に届かない環境）を前提に回せるようにしたい。研修の fork では `config.yaml` に `github:` を書かない（未設定）。
`forge-unset-decide`（#96）で判断と次の一手が、`branch-plan-review`（#97）で計画レビューまでが、未設定のボードで回るようになった。
ただ承認の後は回らない。

- 実装の手（`implement.md`）は節ごとに `git push` し、`# branch.ab +0 -0` で `origin` と一致したかを確かめる。未設定のボード（研修ではオフライン）ではここで止まる
- AI レビューの段（`board-reviewer`）は、カードの `mr` が null なら止まり、PR の差分を読み、push する
- 締めの段は `ai-board pr checks` / `pr edit` / `pr ready` を前提にし、証拠を PR の本文に書く。PR が無いので書く先も、人の番に渡す印も無い
- 締めを終えたカード（ブランチで計画が archive 済み）は、PR が無いので PR中 の列が立たず 実装中 に残る。段は `close`（archive 済み）になり、ループが毎周 `ai-board pr ready` をやり直して止まる

### What Changes

使う人から見た変化は次のとおり（どれも `config.yaml` に `github:` が無いボードだけ）。

- 計画を承認すると、ループの実装の手が節ごとにコミットだけして（push しない）タスクを倒す
- AI レビューの段は、手元の `main` とカードのブランチの差分を読み、指摘を計画に書いてコミットする（push しない）
- 締めの段は、CI を確かめずに（CI が無く、手元の品質ゲートが唯一の確かめ）、動作確認の結果・判断してほしいこと・見送った指摘を、archive する前の計画の末尾に節として書き、計画を archive してコミットする
- 締めを終えたカードは、列は 実装中 のまま止まりになり、判断待ちに「ブランチ <branch> をマージしてください」と出る。ループは飛ばす。出せる判断は 計画から立て直させる / 中止 で、今の「Draft に戻された」止まりと同じ
- 人がメインのチェックアウトで `git merge --no-ff <branch>` を打つと、archive された計画がメインに入り、カードはマージ済みになる（ステージの規則 1。導出は変えない）
- 接続済みのボード、`github:` を書いたまま使えない / エラーのボードは、何も変わらない

### Impact

- 締めを終えたかの読み取り: `src/board/repositories/branch-plan.repository.ts`（`findClosed` を足す）
- 読むカードの選び方: `src/board/services/branch-plan-target.ts`（`branchCloseTarget` を足す、純関数）
- 止まりの判定: `src/board/services/next-action.ts`（`resolveHold` の実装中の止まりに、マージ待ちを足す）
- ボードの組み立て: `src/board/usecases/queries/get-board.query.ts`
- 手順書: `.claude/skills/board-loop/implement.md`・`rules.md`・`SKILL.md`、`.claude/agents/board-reviewer.md`、`.claude/HARNESS_VERSIONS.md`
- ドキュメント: `docs/adr/0004-plans-in-draft-pr.md`、`docs/specs/board-hold/spec.md`、`docs/architecture.md`、`README.md`
- ステージの導出（`stage-resolver.ts`）・出せる判断（`decisionsFor`）・データ用ブランチの形の版・GitHub への問い合わせ: 変わらない

## 設計

### Decisions

#### 締めを終えたかを、ブランチから読む口

- `BranchPlanRepository` に `findClosed(cardId, branch): Promise<{ archivedAt: string } | null>` を足す
  - ブランチに `.ai-board/plans/<id>.md` が無く、`.ai-board/plans/archive/<id>.md` があるときだけ、archive のファイルを最後に変えたコミットの時刻（`git log -1 --format=%cI <ref> -- <path>`）を返す
  - ブランチ名の検査と参照の解決は、今の `find` / `findActive` と同じもの（`check-ref-format --branch`、`refs/heads/` → `refs/remotes/origin/`）を使う
  - 読めない（ブランチが無い、ファイルが無い、git が失敗した）ときは例外を投げず null を返す
- 読んだ結果はステージの導出（`resolveStage`）には渡さない。止まりの判定にだけ使う（`branch-plan-review` で決めた「ブランチの archive は導出に読まない」を保つ）

#### 読むカードを選ぶ純関数

- `src/board/services/branch-plan-target.ts` に `branchCloseTarget(card, plan): string | null` を置く。次をすべて満たすときだけブランチ名を返す
  - 中止していない、着手済み（`startedAt` が非 null）、`branch` が非 null
  - メインのチェックアウトに計画が無い（`plan` が null。archive も含む。メインに archive があればもうマージ済み）
  - plan ゲートが `approved`（実装中の列に効くカードだけ。`gateStates` で出す。plan を飛ばす宣言で提出が承認と読まれるカードも含む）
- GitHub が未設定かは呼び出し側が見る（`branchPlanTarget` と同じ分け方）

#### 止まりにマージ待ちを足す

- `HoldInput` に `branchClosed: { readonly branch: string; readonly since: string } | null` を足す（未設定のボードで、`branchCloseTarget` が選び `findClosed` が読めたカードだけ非 null）
- `resolveHold` の `impling` は、今の `draftReverted` が null なら、`branchClosed` が非 null のとき止まり（`kind: 'decision'`、`since` は archive のコミットの時刻）を返す
- 理由は `HOLD_REASONS.branchMerge(branch)`: 「ブランチ <branch> の実装と締めが済んだ。メインのチェックアウトで git merge --no-ff <branch> を打ってマージするか、ai-board decide で差し戻して計画から立て直させるか中止してください」
- `kind` は `decision` なので、`decisionsFor` は今のまま 計画から立て直させる / 中止 を出す。`ai-board decide` もそれを通す

#### ボードの組み立て

- `createGetBoardQuery` は、未設定のボードで、`branchCloseTarget` が選んだカードの `findClosed` を `withBranchPlans` と同じく `Promise.all` でまとめて読み、カードごとに `resolveHold` の `branchClosed` に渡す。接続済み / 使えません のボードでは読まない
- メインに計画（archive を含む）があるカードは読まない。人がマージすれば、次の `status` からは読まず、規則 1 でマージ済みになる

#### ループの手順書

- `implement.md`
  - 1: 未設定のボードでは `git pull --ff-only` をしない（`rules.md` のワークツリーへの入り方と同じ）
  - 段の表の「archive 済み」の行: 未設定のボードでは締めを終えたカードはマージ待ちの止まりになり `next` に選ばれない。それでも読んだら（段の食い違い）、何もせず `止まった` で手を終える
  - 2.1 の 5: 未設定のボードでは 3 の push と、4 の `# branch.ab +0 -0` の確かめを飛ばし、変更の行が無いことだけを確かめる
  - 2.2: 未設定のボードでは、2（`ai-board pr checks`）を飛ばす。3 は PR の本文の代わりに、計画の末尾に `## 動作確認の結果`・`## 判断してほしいこと`・`## 見送った AI レビューの指摘` を同じ中身・同じ順で書き、`docs: <id> の動作確認の結果を計画に書く` でコミットする。表の CI の行は `走らせていない`（GitHub が未設定で CI が無い）にする。4 は archive をコミットするだけで、push と `ai-board pr ready` をしない
  - 5（手の終わり）: 未設定のボードの締めは `進めた` で終え、人に、ブランチ名・計画の場所（`git show <branch>:.ai-board/plans/archive/<id>.md`）・マージのコマンド（`git merge --no-ff <branch>`）を伝える
  - ハードルール: 未設定のボードの締めの段に限り、計画の末尾に 3 つの節を足すことを許す
- `.claude/agents/board-reviewer.md`
  - 1: 未設定のボードでは `mr` が null でも止まらず、`git pull --ff-only` をしない
  - 3: 未設定のボードでは `/code-review` も `ai-board pr diff` も使わず、`git -C "$WT" diff main...HEAD` を `REVIEW.md` の観点で読む
  - 書いた後: 未設定のボードでは push と `# branch.ab +0 -0` の確かめを飛ばし、変更の行が無いことだけを確かめる
- `rules.md` の「GitHub が未設定のボード」に、実装の手・レビューの段・締めの段で飛ばすものと、締めの後はマージ待ちの止まりになることを足す
- `SKILL.md` の止まる条件の「承認の後の実装の手は … `止まった` になる（`unset-impl-close` で扱う）」を今の形に書き直し、止まりの一覧にマージ待ちを足す
- `.claude/HARNESS_VERSIONS.md` に v8 を足す

#### ドキュメント

- `docs/adr/0004-plans-in-draft-pr.md` の未設定のボードの段に「締めはブランチで計画を archive し、計画の末尾に証拠を書く。ブランチの archive はマージ待ちの止まりにだけ使い、導出には読まない。人がメインで `git merge --no-ff` するとマージ済みになる」を足し、日付に改訂を足す。退けた案に「ブランチの archive を導出に読んで新しい列を立てる」を足す
- `docs/specs/board-hold/spec.md` に、未設定のボードで締めを終えたカードがマージ待ちの止まりになるシナリオと、メインにマージすると止まりが外れてマージ済みになるシナリオを足す
- `docs/architecture.md` の止まりと未設定のボードの説明、`README.md` の「止まり」と「オフラインの研修（手元モード）」に、マージ待ちの止まりと人のマージの手順（メインのチェックアウトで `git merge --no-ff <branch>`）を足す

### 仮定

- **止まりは導出しても保存しない。** 人の答え（2026-11-07）の「`hold` にして判断待ちに出す」を、`ai-board card hold`（AI が書く plan 保留）ではなく、`resolveHold` が導く止まりとして読んだ。`card hold` は plan ゲートの、差し戻しを直しきれないときだけのものなので（`CLAUDE.md` のハードルール）、実装中のカードには書けない。止まりなら、人がマージすればひとりでに外れる
- **止まりの種類は `decision` にする。** `forge` にすると出せる判断が空になり、計画から立て直させる / 中止 が書けない。人の答えの「直したいときは `decide reject`」を通すには `decision` が要る
- **ブランチの archive の時刻を、止まりの起点にする。** 締めの段は archive を最後のコミットにするので、そのコミットの時刻が「人を待ち始めた時刻」になる
- **`board-reviewer` も直す。** 直さないとレビューの段で止まり、締めの段に届かない。カードのアイデアは実装の手と締めを挙げているが、その間のレビューの段も「実装からマージ済みまで進めたい」の範囲と読んだ（人に判断してほしいこと）
- **差分は手元の `main` と比べる。** 未設定のボードはカードのブランチを手元の `main` から切る（`rules.md`）。`main...HEAD`（分岐点からの差分）にすれば、人が途中で `main` に別のカードをマージしても、そのカードの差分は混ざらない
- **証拠は archive の前に別のコミットで書く。** archive のコミットを計画の移動だけにしておくと、今の締めの段と同じ形で読める。2 つのコミットは同じ手の中で続けて行う
- **未設定のボードで PR 番号を持つカード（`unsetPr`）は、今どおり `forge` の止まりを先に見る。** マージ待ちの止まりは `impling` の中の判定なので、`forgeHold` を先に見る今の順で足りる

### 退けた代案

- **ブランチの archive をステージの導出に読み、新しい列（「マージ待ち」）を立てる:** ステージの導出を変えない（人の答え、2026-11-07）。ブランチの archive を規則 1 に渡すと、マージ前にマージ済みに見える（`branch-plan-review` の仮定）
- **締めの後に `ai-board card hold` を書く:** `card hold` は plan ゲートの差し戻しを直しきれないときだけのもので、実装中のカードに書くと `## レビュー` の読み方（plan ゲートの最新が保留）が変わる。止まりなら保存せずに済む（仮定）
- **締めの段の証拠をカード本文の `## 探索メモ` に書く:** 人の答え（2026-11-07）は計画の末尾。マージでメインに入り、後から計画と一緒に読める
- **AI がメインへマージする:** 人の答え（2026-11-07）。マージは人の判断で、AI はしない
- **締めの後に人が直しを返す口（`fix-pr` に当たるもの）を作る:** 人の答え（2026-11-07）。直したいときは `decide reject` か人が自分で直す。研修で要ると分かったら別のカードにする
- **`board-reviewer` は直さず、未設定のボードではレビューの段を飛ばす:** 書いた者が審査しない決まり（ADR 0011）が未設定のボードだけ外れる（人に判断してほしいこと）

### Risks / Trade-offs

- 締めを終えたカードを判断するたびに、`status` / `decide` が git を数回走らせる。対象は未設定のボードの実装中のカードだけで、研修では数枚にとどまる
- 人がメインにマージせずにブランチで直しを足すと、計画が archive のままなので止まりは外れない。直した後に `git merge --no-ff` すれば同じく外れる
- 人がメインのチェックアウトを別のブランチに切り替えたままにすると、マージしても規則 1 が立たない。README の手順に「メインのチェックアウト（`main`）で打つ」と書く
- 未設定のボードの PR中 にあたる確かめは、CI が無いので手元の品質ゲートと動作確認の結果だけになる

### Non-Goals

- 未設定のボードでの区間の時間（Ready とマージの時刻）を出すこと（人に判断してほしいこと）
- 締めの後に人が直しを返す口（`fix-pr` に当たるもの）
- 使えません / エラーのボードの扱い（`offline-snapshot-view`）
- ステージの導出の変更・新しい列
- AI がメインへマージすること

## 探索メモとの対応

| #   | 探索メモ（短い引用）                                                                                | 反映した先                                                              | 反映しなかった理由 |
| --- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------ |
| 1   | `branch-plan-review` の調べで見つけ、人の答えで別のカードにした                                     | 提案（Why）                                                             |                    |
| 2   | マージ済みの判定は今の規則で足りる。人が `git merge` すれば archive が入りマージ済み                | What Changes・Decisions（ボードの組み立て）・Non-Goals                  |                    |
| 3   | 締めの後の「人の番」の印が無い。段が `close` になり `pr ready` が毎周選ばれて失敗する               | Decisions（止まりにマージ待ちを足す）・Decisions（ループの手順書）      |                    |
| 4   | 証拠の置き場が無い（今は PR の本文に 3 つの節）                                                     | Decisions（ループの手順書の 2.2）                                       |                    |
| 5   | 節ごとの push・`branch.ab +0 -0`・締めの `pr checks` は未設定のボードでは飛ばせばよい               | Decisions（ループの手順書）                                             |                    |
| 6   | 締めの後に人が直しを返す口はオフラインでは無い。残るのは `decide reject`                            | 仮定（止まりの種類は `decision`）・退けた代案                           |                    |
| 7   | ブランチの archive は止まりの判定にだけ使い、導出には渡さない形にする                               | Decisions（締めを終えたかを読む口）・退けた代案                         |                    |
| 8   | 人の答え: 証拠は archive する前の計画の末尾に節として書く                                           | Decisions（ループの手順書の 2.2）・仮定（証拠は別のコミット）           |                    |
| 9   | 人の答え: 締めを終えたカードは 実装中 のまま止まり（`hold`）にして判断待ちに出し、ループは飛ばす    | Decisions（止まりにマージ待ちを足す）・仮定（止まりは導出し保存しない） |                    |
| 10  | 人の答え: マージは人がメインのチェックアウトで `git merge --no-ff <branch>`。手順書と README に書く | Decisions（ループの手順書・ドキュメント）・退けた代案                   |                    |
| 11  | 人の答え: 締めの後に人が直しを返す口は作らない                                                      | Non-Goals・退けた代案                                                   |                    |

## 動作確認の手順

ワークツリーは `$MAIN/.claude/worktrees/unset-impl-close`（以下 `$WT`）。`rules.md` の「動かして確かめるとき」のとおり、スクラッチパッドの bare リポジトリを `origin` にした clone（`$S/data`）を `AI_BOARD_DATA` で指す。
計画とカードのブランチを置くために、空の git リポジトリ `$S/repo`（`main` に空のコミット）を作り、`--root $S/repo` で走らせる。`config.yaml` は置かない（未設定）。以下 `B` は `AI_BOARD_DATA=$S/data node $WT/dist/cli.js` と `--root $S/repo` を付けて走らせることを指す。

1. 締めを終えたカードがマージ待ちの止まりになる
   - コマンド: `B card create --id alpha …` → `B decide start alpha`。`$S/repo` で `git switch -c alpha` して `.ai-board/plans/alpha.md` をコミットし、`main` に戻る。`B card branch alpha alpha` → `B card submit alpha --reason なし` → `B decide approve alpha`。ブランチ `alpha` で `git mv .ai-board/plans/alpha.md .ai-board/plans/archive/alpha.md` をコミットし、`main` に戻って `B status --json --only next,waiting`
   - 期待: `next` が `alpha` を選ばない。`waiting` に `alpha` が `stage: impling` で出て、`hold.reason` に「ブランチ alpha」と `git merge --no-ff alpha` があり、`decisions` が 計画から立て直させる / 中止
2. 止まりのカードを差し戻せる
   - コマンド: 1 の後に、同じ手順で作ったカード `gamma` について `B decide reject gamma --reason 立て直す`
   - 期待: `gamma: plan 差し戻し を書きました（実装中 → 計画提案中）`
3. メインにマージするとマージ済みになる
   - コマンド: `$S/repo`（`main`）で `git merge --no-ff alpha` → `B status --json --only cards.id,cards.stage,waiting`
   - 期待: `alpha` が `merged` で、`waiting` に出ない
4. 締めの前（ブランチに active の計画がある）は止まらない
   - コマンド: 1 と同じく承認まで進めたカード `beta`（archive しない）で `B status --json --only next`
   - 期待: `next` が `beta` の `implement`
5. `github:` があるボードではブランチの archive を読まない
   - コマンド: `$S/repo/.ai-board/config.yaml` に `github:`（`repository: 'example/none'`）を書き、`gh` の無い `PATH` で `B status --json --only cards.id,cards.hold`
   - 期待: マージ待ちの止まりが出ない（今どおり）
6. 未設定のボードでループが承認から締めまで進み、人のマージでマージ済みになる（共有のカードと手順書を使うので AI は走らせていない。人が研修の fork で確かめる）
   - コマンド: 研修の fork で `github:` を消して計画を承認し、`/board-loop` を回す。締めの後に判断待ちに出たら、メインのチェックアウトで `git merge --no-ff <branch>`
   - 期待: 実装の手とレビューの段が push と `ai-board pr` をせずに進み、締めの段が計画の末尾に 3 つの節を書いて archive する。カードがマージ待ちで判断待ちに出て、マージの後にマージ済みになる

## タスク

### 1. 締めを終えたカードをマージ待ちの止まりにする

- [x] `src/board/repositories/branch-plan.repository.ts` に `findClosed` を足す（active が無く archive がある、archive のコミットの時刻）
- [x] `src/board/services/branch-plan-target.ts` に `branchCloseTarget` を置く
- [x] `src/board/services/next-action.ts` の `HoldInput` に `branchClosed` を、`HOLD_REASONS` に `branchMerge` を足し、`resolveHold` の `impling` でマージ待ちの止まりを返す
- [x] `src/board/usecases/queries/get-board.query.ts` で、未設定のボードのとき `branchCloseTarget` が選んだカードの `findClosed` を読み、`resolveHold` に渡す
- [x] テスト: `findClosed`（一時の git リポジトリで、archive だけなら時刻・active があれば null・不正なブランチ名で null）、`branchCloseTarget`（各条件）、`resolveHold`（マージ待ち、Draft に戻されたほうが先、中止なら null）、`get-board.query`（未設定ならマージ待ち、接続済みなら読まない、メインに計画があれば読まない）、`decide-cli`（マージ待ちのカードを差し戻せる、承認は拒む）

### 2. ループの手順書とドキュメント

- [x] `.claude/skills/board-loop/implement.md` の 1・段の表・2.1 の 5・2.2・5・ハードルールを、未設定のボードでは push と `ai-board pr` を飛ばし、証拠を計画の末尾に書く形に直す
- [x] `.claude/agents/board-reviewer.md` を、未設定のボードでは `mr` が null でも止まらず、`git diff main...HEAD` を読み、push しない形に直す
- [x] `.claude/skills/board-loop/rules.md` の「GitHub が未設定のボード」と `SKILL.md` の止まる条件・止まりの一覧を直す
- [x] `docs/adr/0004-plans-in-draft-pr.md` を書き直し（`adr` のスキル）、`docs/specs/board-hold/spec.md`・`docs/architecture.md`・`README.md` を直す
- [x] `.claude/HARNESS_VERSIONS.md` に v8 を足す（人の判断で上げないなら、このタスクを外す）
