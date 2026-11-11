# 実装の細部

触る箇所に応じて読めばよい細部。使い方・ステージの判定表・止まり・ループの流れは `README.md`、
不変条件とハードルールは `CLAUDE.md`、なぜそう作ったかは `docs/adr/` にある。ここではそれらを繰り返さない。

## ディレクトリ

```
src/
  cli.ts / cli-main.ts  CLI の入口（サブコマンドの振り分け）
  shared/               ブラウザでも動く値と型だけ（Result<T,E>・Branded Types・区切り線の ID・列の見出し）。ADR 0018
  cards/                カードの読み書きのコンテキスト
  board/                3 ソース統合・ステージ導出のコンテキスト
  infrastructure/       外部コマンド・設定とワークツリーの解決・データのワークツリー・GitHub の問い合わせ
```

各コンテキストは `models/ errors/ services/ repositories/ usecases/ presenters/ cli/ composition.ts` を持つ。

## ゲートの状態

`src/cards/services/review-log.ts` が `## レビュー` から読む。ゲートは `plan` だけ（`REVIEW_GATES`）。
廃止した `explore` / `verify` のエントリ・判断のファイル・`skipGates` は黙って読み飛ばす（`isRetiredReviewGate`）。

- `gateState()` の値は `none` / `submitted` / `held` / `approved` / `rejected`。中止を除いた最新エントリ 1 件で決まる
- `skipGates` のあるゲートでは、最新が 提出 / 再提出 なら `approved` と読む。種別は書き換えないので、人の承認か AI の提出かは `latestGateEntry` の種別で見分ける
- `gateStates()` は導出（`toFacts`）と、提出・保留の usecase が使う
- 判断待ちの区画の本文と待ち始めの時刻は、`GATE_OF_STAGE` のゲートの最新エントリ（ゲートの無い列はゲートを問わない最新）から取る

## Draft の PR と止まり

Draft の PR は計画レビューの列を立てるが、その規則は plan が未承認のときだけ当たるので、実装中の Draft の PR は巻き戻らない。
GitHub が未設定のボードでは、Draft の PR の代わりにカードのブランチの `plans/<id>.md` を読む（`GitBranchPlanRepository.findActive`）。
読むのは `branchPlanTarget`（`src/board/services/branch-plan-target.ts`）が選んだカード（着手済み・`branch` あり・メインに計画なし・plan が規則 4 の `planReviewable`）だけで、`get-board.query.ts` がメインの計画の無いところに重ねる。
ブランチの `archive/` はステージの導出には読まない。読むと、締めで archive して Ready にした PR中 のカードがマージ前にマージ済み（規則 1）に見える。
未設定のボードでは、締めが済んだか（ブランチに `plans/<id>.md` が無く `plans/archive/<id>.md` がある）だけを `GitBranchPlanRepository.findClosed` で読み、マージ待ちの止まりにだけ使う。
読むのは `branchCloseTarget` が選んだカード（着手済み・`branch` あり・メインに計画なし・plan が `approved`）だけ。人がメインのチェックアウトで `git merge --no-ff <branch>` すれば、メインに archive が入って規則 1 でマージ済みになる。
`draft` だけでは「まだ Ready にしていない」と「人が Draft に戻した」を見分けられないので、
最後の `convert_to_draft` の時刻を `PrState.convertedToDraftAt` に持つ。

止まりは `src/board/services/next-action.ts` の `resolveHold` が導き、`BoardCard.hold`（`{ kind, reason, since }` か `null`）に載る。
`kind` は人の判断で解く `decision` と、PR の状態を引けない `forge` の 2 つ。`reason` の文は `HOLD_REASONS`。
未設定のボードのブランチのマージ待ち（`branchClosed`）は `decision` で、出せる判断は Draft に戻された止まりと同じ 計画から立て直させる / 中止。

- `forge`: そのカードの PR だけを直近の取得で引けなかった（`PrStateProvider.failure`）。アイデア / マージ済み / 中止を除いて立ち、ほかより先に見る。
  前に引けた控えは古いことがあるので、`decisionsFor` と `droppableStages` を空にし、`ai-board decide` も判断と着手を拒む
- 実装中で、人の最新の判断より後に `convertedToDraftAt` がある（見ないと締めの段が Ready にし直してしまう）
- 計画提案中で、plan の最新が 保留
- 計画提案中で、plan が提出済みなのに計画ファイルも Draft の PR も見えない。PR の状態を引けていない（未接続・未取得・そのカードの失敗）ときは立てない

## 書き込みの境界

`ai-board card`（`src/cards/cli/card-cli.ts`）の書き込みは `CardCliDependencies.writes`
（`src/cards/usecases/commands/card-write.commands.ts` の `createCardWriteCommands`）だけを通る。
各 usecase は `transactCardWrite` の中で走り、コミットのメッセージも決める。

- `submit` / `hold` は種別を中で決める usecase（`submit-review.command.ts` / `hold-review.command.ts`）を通り、
  書けない理由を `SubmitBeforeStart` / `SubmitGateClosed` / `HoldGateNotRejected` で返す。`--gate` は `plan` だけを受ける
- `branch` は `link-card-branch` を通る。`appendReviewCommand` と `updateCardMetaCommand`（`startedAt` / `skipGates`）は CLI の依存に渡さない

`ai-board decide`（`src/board/cli/decide-cli.ts`）は引数を確かめて `createDecideCommands`（`src/board/usecases/commands/decide.command.ts`）を呼ぶだけ。
usecase は `transactCardWrite` の中で、`status` と同じ組み立てでボードを導出し、`src/board/services/decision-guards.ts` で出せる判断かを確かめて書く。
push が拒否されたら取り直したボードで検査からやり直す。書いた後は移った先の列を返す。

判断の追記と本文の保存はリポジトリ（`CardRepository`）の別の口で、判断の偽造を防ぐのは入口の検査ではなくこの作りである。

- **判断は値のまま 1 件だけ足す。** `appendReview` は `log/` に判断のファイルを 1 つ書き（`card-files.ts` の `planReviewAppend`）、`card.md` に触らない。
  理由に `### <時刻> <gate> <種別>` の行があっても判断は 1 件で、組み立てるときに `####` へ下がる
- **本文の保存は判断を作らない。** `save`（`planCardWrite`）は本文とメタだけを書く。送られた本文に `## レビュー` の節が無ければそのまま書き、
  節があれば `parseReviewLog` のエントリが今と同じときだけ節を除いて書き、違えば `ReviewEntriesChanged` で拒む（`createUpdateCardBodyCommand` も同じ）

## 区画と出せる判断

区画への振り分け・並びは `src/board/services/board-sections.ts`、出せる判断は `decision-options.ts`、アイデアの区切りは `idea-tiers.ts` の純関数で、ステージの導出とは別物。

- `sectionOf` / `groupBySection`: 区画は inbox（判断待ち）/ work（AI 作業中）/ idea / merged / aborted。`hold` のあるカードは inbox で、待ち始めは `hold.since`。
  PR中 でも `prState.awaitingFix` なら work の先頭（`isAwaitingPrFix`）
- `decisionsFor`: 出せる判断（表は README）。どの判断も plan に書き、`skipGates` の有無では出し分けない
- `droppableStages` / `resolveFloorStage`: 着手を戻せる下限（`startedAt` を外したときに残るステージ）
- 動きなし（`stale`）: AI 作業中のカードで、計画ファイルの更新（計画が無ければ `startedAt`）から 3 日。PR中 のカードは数えない

アイデアの区切り線は `rank` と同じ物差しの値を 1 つ持ち（`order.yaml` の `divider`）、並べ替えではカードと同じ 1 項目（`DIVIDER_ID`）として扱う（`move-in-order.ts`）。

## `ai-board status` と次の一手

ボードは `src/board/composition.ts` の `assembleBoard`（`createPrStateSource` → `getBoardQuery`）が組み、`status` と `decide` が共有する。
PR の状態は `refresh()` を 1 回待って引き、`branch` から解決した PR 番号の書き戻しもここで起きる。
見せる形は `src/board/usecases/queries/get-status.query.ts` が組み、`status-cli.ts` は引数と整形だけを持つ。

人に読ませる 1 行（エラー・拒否・書いた結果・「GitHub:」「ループ:」「次の一手:」の行）は、入口に依存しない presenters の純関数が作る。
ボードの文言は `src/board/presenters/`、カードの文言は `src/cards/presenters/`、データ用ブランチの失敗は `src/infrastructure/data-store-messages.ts`（外部コマンドの失敗の `describeCliError` と同じ置き方）に置く。
CLI はそれを呼んで出力し、戻す HTTP の入口も同じものを呼ぶ。`cli/` の外から `cli/` を import しないことは eslint の `@typescript-eslint/no-restricted-imports` で止める。
ただし、CLI でだけ使う操作（`loop` / `init`）の文言と、端末向けの並べ方（`formatStatus` / `formatPullRequest` など）は `cli/` に残す。
既知の制約として、presenters の文言には CLI の語彙（`--reason`・`--after` / `--before`・`ai-board init`・`AI_BOARD_DATA` など）が残っている。HTTP の入口を戻すときに、直し方の案内を入口の層へ分けるかを決める。

- 人向けの形は「GitHub:」「ループ:」の行・判断待ち・AI 作業中・次の一手だけを出す（`src/board/presenters/status-describe.ts`）。`--json` は `next` / `waiting` / `working` / `cards` / `ideas` / `forge` / `loop` / `generatedAt`
- `--only <項目,...>`（`pickFields`）は `<key>` か `<key>.<field>`（最上位の配列の各要素から 1 項目）で絞る。入れ子は 1 段まで。誤りは GitHub に問い合わせる前に失敗する
- `--active`（`onlyActiveCards`）は `cards` から区画が マージ済み と 中止 のカード（`board-sections.ts` の `isActiveCard`）を外す。ほかの項目は変えず、`--only` の前に効く。`--json` と一緒にだけ使える
- 次の一手は `src/board/services/next-action.ts` の `pickNextAction`。GitHub が接続済みか未設定（`forgeTrusted`）でないと `next` は `null`。未設定のボードで PR 番号を持つカードは止まりになり選ばれない
- `implement` のときだけ、query が選んだ 1 枚のブランチの計画を読んで `next.step` を埋める（`pickNextAction` 自体は `step: null` を返す純関数）。
  `git show <ref>:.ai-board/plans/<id>.md`、無ければ `plans/archive/<id>.md` を読む。`<ref>` はローカルの `refs/heads/<branch>`、無ければ `refs/remotes/origin/<branch>`。
  `git check-ref-format --branch` を通らない名前では `git` を呼ばず、`git fetch` もしない。読めなければ `step` は `null`（人向けは `段=不明`）
- 段は `src/board/services/impl-step.ts` の `resolveImplStep`。タスクの行とコードブロックの外し方（`src/board/models/plan-task.ts` の `linesOutsideCodeBlocks`）は計画の進捗と共有する。
  段はステージではなく、ボードの組み立てとステージの導出はブランチの計画を読まない
- `loop/` に残る廃止した手（`revise-impl` / `ready`）は `LOOP_PAST_ACTIONS` として読めるが、`loop start` では受けない

## カードの保存

データ用ブランチの中身（形は `src/cards/repositories/card-files.ts` の純関数が読み書きする）:

```
ai-board-data.yaml                      形の版（version: 2）。CLI はこれより新しい版を読まずに止まり、古い版は書き換える
config.yaml                             GitHub の接続設定（ai-board init が .ai-board/config.yaml を写す）
order.yaml                              rank とアイデアの区切り線（{ divider, ranks: { <id>: <数> } }）
cards/<id>/card.md                      frontmatter（id, title, created, skipGates, branch, pr）と本文
cards/<id>/log/<時刻>.<gate>.<種別>.md   判断 1 件。中身は理由の本文。追記だけで、書き換えも削除もしない
snapshots/<id>.json                     マージ済みの PR の控え
loop/<時刻>.<ループの識別子>.json        ループの 1 手の記録。カードではない
```

`startedAt` は `log/` の着手・着手を戻すの最新から、`rank` は `order.yaml` から、`## レビュー` の節は `log/` から組み立てる（`card.md` の節は読まない）。
`card.md` が読めない・項目が不正・`id` がディレクトリ名と食い違うカードは、警告して読み飛ばす。

**形の版の移行。** 取り直した版がこの CLI より古ければ、`src/infrastructure/data-migration.ts` の `migrateData` がワークツリーのファイルを今の版へ書き換える。
読み出しでは書き換えるだけでコミットしない（取り直すたびに書き換え直す）。書き込みでは `op` の前に書き換えを `data: 形の版を <版> に上げる` の 1 コミットにし、`op` のコミットと一緒に push する。
push した後は古い CLI が `UnsupportedDataVersion` で止まるので、メインのチェックアウトを pull してビルドし直す。
版 2 はカードの PR 番号を `mr` から `pr` に、控えの `mr` / `iid` を `pr` / `number` に改めた。

**置き場所。** メインのチェックアウトの `.ai-board/data/` に `git worktree add` で置く（`dataDir`）。`sharedBoardDir` がどのワークツリーからもここに解決する。
`AI_BOARD_DATA` を指すとそのディレクトリを使い、その `origin` に push する。`data.lock` と `cache/` は `dataDir` の親に置き、git に載せない。
データ用ブランチが `origin` に無ければ止まり、`ai-board init`（`src/cards/cli/init-cli.ts`）を案内する。

**書き込み。** どれも `DataStore.transact`（`src/infrastructure/data-store.ts`）の 1 操作として走る。

1. ロックを取る（`data.lock` を排他作成。持ち主の pid が死んでいれば取り直す。5 秒で諦める）
2. 取り直す（`git fetch origin +refs/heads/ai-board/data:refs/remotes/origin/ai-board/data` → `reset --hard` → `clean`）
3. 操作を走らせる（検査も usecase もここで最新の状態に対して行う）。何も書かなければコミットしない
4. `git add --all --force -- <DATA_PATHS>` と `git add --update` → `git commit`（メッセージに理由の文は入れない）→ `git push origin HEAD:refs/heads/ai-board/data`
5. push が拒否されたら rebase せずに 2 から頭からやり直す（3 回まで）

rebase しないのは、離れた行の編集を git が黙って混ぜ、検査を経ない状態が push されうるからである。
読み出しはコマンドの頭で 1 回取り直し、fetch に失敗したら警告して手元の内容で読む（書き込みは失敗にする）。
`origin` の無いデータのワークツリー（テスト用）では fetch と push を飛ばす。

**手元モード。** `dataDir` の親の `data-mode.yaml` に `mode: local` と書くと、`origin` に触れずに手元の commit だけで読み書きする（研修用。ADR 0010・README）。
既定のモードの取り直しは、`origin` に無い commit が手元にあれば `DataStoreLocalAhead` で止まる。

## GitHub の PR の取得

`config.yaml` に `github:` が無ければ（未設定。`isForgeUnset`）PR中 / マージ済み の列が空になるだけでボードは動き、人の判断と次の一手も接続済みと同じに通す（`forgeTrusted`）。
未設定のボードで PR 番号を持つカード（途中で `github:` を外した）は、そのカードだけを止まり（`forge`、`unsetPr`）にする。
`github:` があって使えない・エラーのときは、判断と着手を拒み `next` を出さない（列を取り違えるため）。
使えない（`checkAuth` が失敗した）あいだも、データ用ブランチのマージ済みの控えのうち、カードの `pr` と番号が合うものだけは PR の状態として出す（`matchMergedSnapshots`、`unavailablePrStateProvider`）。
マージ済みは二度と変わらないので古さを気にしない。マージ前の控え（`cache/`）は古いことがあるので使わず、`synced` も偽のままにする。

- 引けるかは CLI を動かすたびに `gh api repos/<owner>/<repo>` を 1 回引いて確かめる（`ForgeClient.checkAuth`）。クラウドでは `gh auth status` が失敗するので使わない
- 失敗は `failureScope` で分ける。`global`（`gh` が無い・ステータスが取れない・401 / 403 / 429・5xx）は接続をまるごと `error` に、
  `card`（ほかの 4xx・読めない JSON）はそのカードの `failure` にして前の控えを返し、止まり（`forge`）にする。404 は「PR が無い」。
  `ForgeRequestError` には問い合わせ先の道とステータスだけを載せ、`gh` の stderr は載せない（資格情報が混じりうる）
- マージ済みも `state: closed` で返るので、`merged_at` の有無で分ける（`toLifecycleState`）
- コメントは issue comment と review comment を `--paginate` で全ページ引いて合算する。`user.type === 'Bot'` は外す
- 最新コミットは `head.sha`。`issues/{n}/events` から最後の `ready_for_review`（無く Ready なら作成時刻）を `readyAt`、
  最後の `convert_to_draft`（今 open かつ Draft のときだけ）を `convertedToDraftAt` にする（`draftTransitionsOf`）
- PR 一覧は引かず、カードごとに `pr`、無ければ `branch` から解決して番号を書き戻す（`PrFetcher.fetchFor`、`createTransactionalPrWriter`）

**PR の指摘に AI が応える番。** AI も人のアカウントで書くので、本文の最後の行が Claude Code のフッター（`CLAUDE_CODE_FOOTER`）であるコメントを AI のもの（`isAiComment`）とする。
引用の中のフッターで人の指摘を見落とさないよう、含むだけでは読まない。`ai-board pr comment` はフッターを足す（`withClaudeCodeFooter`）。
`src/board/services/pr-feedback.ts` の `awaitsPrFix` は、Ready で開いた PR で人の最新のコメントが最新コミットと AI の最新のコメントより後のときに真で、
`BoardCardPr.awaitingFix` に載る。読むのは区画と次の一手（`fix-pr`）だけで、ステージは変えない。

**控え。** PR 1 枚で 4 回以上引くので、結果を控えて問い合わせを省く（`src/board/repositories/file-pr-snapshot.repository.ts`）。

- マージ済みの PR は二度と引かず（`isSettled`）、データ用ブランチの `snapshots/<id>.json` に `transact` で書く
- 中止のカードの PR も、控えがあれば引き直さない（`canReuseSnapshot`）。中止のカードは区画が 中止 に固定され、PR が変わっても何にも効かないため。問い合わせの対象には残すので控えは消えない。控えが無ければ一度引く
- それ以外は `pulls/{n}` の指紋（`fingerprintOf`）が前回と同じなら詳細を引かない。控えは `<dataDir の親>/cache/pr-snapshots.json`
- GitHub に届かないときは、マージ済みの控え（`findMerged`）だけを読み、書かない（`PrFetcher` を作らない）
- 控えは導出の入力ではないので、書けなくても警告だけ。`PrState` に項目を足すと古い控えは検証で外れ、`enrich` を変えたら `FINGERPRINT_VERSION` を上げる

### `ai-board pr checks`

締めの段が Ready の前に CI を確かめる（`src/board/cli/pr-cli.ts`、判定は `src/board/services/pr-checks.ts`）。ボードの表示と導出には使わない。

- `commits/{sha}/check-runs` と `commits/{sha}/status` を全件引いて 1 つの表にする。`--sha` は短いハッシュも受け（`isSameCommit`）、PR の head がまだそれでなければ走っているとみなす
- 判定と終了コード: `passed` / `none` は 0、`failed` は 1、`pending` は 2、読めなければ 3
- `--wait` は 15 秒おきに引き直し、チェックがまだ無い間も head になってから 120 秒は待つ。`--timeout`（既定 900 秒）で `pending`
- `status` が 403 / 404（クラウドの GitHub App）なら `check-runs` だけで判定し、`statusUnreadable` に理由を出す

## カードの JSON

`status --json` の `cards[]` は本文を除いたカードに、`hold`・`prState`（`readyAt` / `convertedToDraftAt` / `awaitingFix` など）・`loopSteps`・`reviews`（`{ at, gate, kind, reason }`）を足したもの。
`reviews` の理由は組み立てた本文から読むので、見出しは `####` に下がっている。

## ループの 1 手の記録

型は `src/board/models/loop-step.ts`、読み書きは `src/board/repositories/loop-history.repository.ts`、CLI は `src/board/cli/loop-cli.ts`。

- ファイル名は `loop/<開始の時刻>.<ループの識別子>.json`（時刻は `toLogStamp`、重なれば `-2`）。識別子は `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`
- 中身は `{ loop, cardId, action, step, agent, startedAt, finishedAt, result }`。`start` で作り、`finish` で 1 度だけ埋める
- 以前の記録に残る `harness` / `tokens` / `durationMs` は、読むときにスキーマが落とす
- `agent` はレビューの段で立てた `board-reviewer`、自分で進めた手は `null`
- `result` は `advanced` / `held` / `stopped` / `failed` / `unknown` と、`loop start` が同じループの終わっていない記録を閉じるときの `interrupted`
- `finish` は終わっていない記録が無いか `--card` が食い違えば拒む。`loop-cli.ts` はカードの存在を読む関数だけを受け取り、カードを書けない
- 手と段の語は `LOOP_VOCABULARY_IN_SYNC` で `NextActionKind` / `ImplStep` と食い違えば型エラーになる

`GetBoardQuery` が全件を読んで `Board.loop`（`toBoardLoop`）と `loopSteps` を組む。導出・止まり・次の一手には渡さない。
「ループ: …」の行は `src/board/services/loop-activity.ts` の `summarizeLoop`。
