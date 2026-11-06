# 判断の書き込みとボードの見せ方の段取りを、CLI の外の usecase と query へ移す

## 人に判断してほしいこと

- **`card` の CLI の `updateCardMetaCommand` を、ブランチの紐付けの専用の usecase に替えるか。** 替えると、`card` の CLI の依存から `startedAt` / `skipGates` を書ける口が型の上でも消える。
  PR #88 では「今回は入れない」と答えをもらったが、それは #88 の範囲についての答えで、このカードは計画で決めるとしている。
  このカードでは `card` の書き込みを 1 操作ずつの usecase に包み直すので、紐付けだけ `updateCardMetaCommand` のまま残すと、包み直した口から `startedAt` を書ける形が残る（既定: 入れる）
  - → 回答（2026-11-06、plan 承認）: 理由なしで承認（既定のまま進む）
- **push が拒否されて書き込みをやり直すたびに、計画ファイル名の不正などの読み飛ばしの警告が重ねて出る件を、このカードで直すか。** 直すと標準エラーの出力が変わり、このカードの「CLI の出力を変えない」とぶつかる。
  重ねて出るのは push が拒否されたときだけで、出る警告の中身は正しい（既定: 入れない。別のカードにする）
  - → 回答（2026-11-06、plan 承認）: 理由なしで承認（既定のまま進む）
- **CLI の外へ移すのを、カードが挙げた 4 つだけにするか。** 4 つは、`decide` の段取り、`status` の見せる形、ボードと `decide` の依存の組み方、`card` のコミットのメッセージである。
  `card` の読む口（`list` / `show` / `seed` の既にある ID の確かめ）は、今のままリポジトリを直に読む。`loop` / `pr` / `init` の CLI にも触らない（既定: 4 つだけ）
  - → 回答（2026-11-06、plan 承認）: 理由なしで承認（既定のまま進む）

承認は、回答の無い項目をすべて既定のまま進めると読む。既定と違う答えは、承認の理由ではなく差し戻しの理由で返してほしい。

## 提案

### Why

`cli-rules-to-usecases`（PR #88）で、拒否のルールは CLI の外へ出た。
提出と保留の検査は usecase に、人の判断の検査は `decision-guards.ts` の純関数になった。書き込みの包み方も `transactCardWrite` の 1 つにまとまった。
それでも、ルールを使って「どう書くか」「何を見せるか」を組み立てる段取りは、まだ CLI の中に残っている。

- `ai-board decide` の段取りは、`src/board/cli/decide-cli.ts` の `decide()` と `reportWrite()` にある。ボードを導出し、検査し、書き、コミットのメッセージを決め、書いた後の列を読み直す
- `status` が見せる形は `src/board/cli/status-cli.ts` にある。判断待ち・作業中・アイデアの表・次の一手を組む `buildStatusReport` と、`next.step` を埋める `withImplStep` である
- ボードの組み立て（`assembleBoard`）と `decide` の依存の組み方は `src/cli-main.ts` にある。CLAUDE.md の「依存はコンテキストごとの `composition.ts` で組む」から外れている
- `card` のコミットのメッセージ（`data: <id> に plan 提出 を足す` など）は、`src/cards/cli/card-cli.ts` が決めている

画面はいずれゼロから作り直す（ADR 0017）。
今のままでは、そのとき API から同じ判断を書き、同じ形でボードを見せるために、これらを写すことになる。
CLI に残すのを、引数の解析と人に読める文への直しだけにし、画面と API からも同じ段取りを呼べるようにしておく。

### What Changes

- `transactCardWrite` を `src/cards/composition.ts` から `src/cards/usecases/commands/` へ移す。usecase が自分で書き込みの 1 操作を開けるようにするためである
- `assembleBoard` と `decide` の依存の組み方を、`src/board/composition.ts` へ移す
- `status` の見せる形を、query（`src/board/usecases/queries/get-status.query.ts`）にする。`StatusReport` などの型は `src/board/models/status-report.ts` へ移す。
  `status-cli.ts` には、引数の解析・`--only` の絞り込み・人向けの数行と JSON への整形だけを残す
- `decide` の段取りを、usecase（`src/board/usecases/commands/decide.command.ts`）にする。
  ボードの導出・検査・書き込み・コミットのメッセージ・書いた後の列の読み直しを usecase が持ち、`Result<_, DecideError>` を返す。
  `DecideError` は `src/board/errors/board-errors.ts` へ移す。`decide-cli.ts` には、引数の解析と、エラーと結果を文に直すことだけを残す
- `card` の書き込みを、コミットのメッセージを持つ 1 操作ずつの usecase（`src/cards/usecases/commands/card-write.commands.ts`）に包む。
  ブランチの紐付けは専用の usecase（`link-card-branch.command.ts`）にする（人に判断してほしいこと）
- CLAUDE.md・`docs/architecture.md` の、名前で指している箇所を今の形に直す
- CLI の出力（標準出力・標準エラーの文・終了コード）とコミットのメッセージは変えない

### Impact

- カード: `src/cards/composition.ts`、`src/cards/usecases/commands/`（`transact-card-write.ts`・`card-write.commands.ts`・`link-card-branch.command.ts` を足す）、`src/cards/cli/card-cli.ts`
- ボード: `src/board/composition.ts`、`src/board/errors/board-errors.ts`、`src/board/models/status-report.ts`（足す）、
  `src/board/usecases/queries/get-status.query.ts`（足す）、`src/board/usecases/commands/decide.command.ts`（足す）、`src/board/cli/decide-cli.ts`、`src/board/cli/status-cli.ts`
- 入口: `src/cli-main.ts`（取り直しと組み立ての呼び出しだけになる）
- テスト: `src/board/cli/__tests__/decide-cli.test.ts`・`status-cli.test.ts`、`src/cards/cli/__tests__/card-cli.test.ts` の依存の組み方。
  usecase と query のテストを `src/board/usecases/__tests__/`・`src/cards/usecases/__tests__/` に足す
- ドキュメント: `CLAUDE.md`（書き込み境界の段落）、`docs/architecture.md`
- 導出（`stage-resolver.ts`）、データ用ブランチの形、CLI の引数と出力、コミットのメッセージ、手順書（`.claude/`）は変わらない

## 設計

### Decisions

- **`transactCardWrite` は `src/cards/usecases/commands/transact-card-write.ts` に置く。**
  今は `cards/composition.ts` にあり、composition が usecase を import している。usecase がこれを使うと、usecase から composition を import して循環する。
  中身（`CardWriteRefusedError` を `CardWriteRefused` の Err に直す）は変えない。`card-errors.ts` の `CardWriteFailure` の説明も「usecase が開いた書き込みの 1 操作の中で起きる」に直す
- **`decide` の usecase。** `createDecideCommands({ loadBoard, store, cards })` が、判断ごとの関数 `review` / `start` / `unstart` / `skip` / `move` / `moveDivider` を返す。
  - 入力は引数の形を確かめた後の値（`CardId`、`--reason` を trim した文、`ReviewGate`、`OrderRef | null`）にする。引数の形の誤り（カード ID の形・`--gate` の値・`--after` / `--before` の値・自分自身を隣に指定）は、今と同じく CLI がボードを読む前に拒む
  - 中身は今の `decide()` と同じで、`transactCardWrite` の中でボードを導出し、`decision-guards.ts` で検査し、カードの usecase で書く。push が拒否されれば検査からやり直す（ADR 0010）
  - コミットのメッセージは usecase が決める。文は今と同じ（`data: <id> に <gate> <kind> を足す`、`data: <id> の startedAt を変える`、`data: <id> の skipGates を変える`、`data: <id> を並べ替える`、`data: 区切り線を動かす`）
  - `review` / `start` / `unstart` / `skip` は、書いた後にボードを読み直し、`{ id, what, from, to }` を返す。`to` は書いた後の列で、読めなければ null にする。CLI はこれを今と同じ 1 行（`<id>: <what> を書きました（<from> → <to>）`）に直す
  - `move` / `moveDivider` は、今と同じく書いた結果だけを返す
- **`DecideError` は `src/board/errors/board-errors.ts` に export する。** 中身は今と同じ（`DecideRefusal | BoardUnreadable | AppendReviewError | UpdateCardError | MoveCardError | CardWriteFailure` と `DataStoreError`）。
  人に読める 1 行への直し（`describeDecideError` / `describeRefusal`）は CLI に残し、`switch` で種別を網羅する
- **`status` の query。** `createGetStatusQuery(getBoardQuery, branchPlanRepository?)` が `(now: Date) => Promise<Result<StatusReport, GetBoardError>>` を返す。
  中身は今の `buildStatusReport` と `withImplStep` で、ボードを読み、見せる形を組み、`next.action` が `implement` のときだけ選ばれたカードのブランチの計画を読んで `next.step` を埋める。
  `StatusReport` / `WaitingCard` / `WorkingCard` / `StatusCard` / `IdeaListRow` は `src/board/models/status-report.ts` に移す。
  `STATUS_KEY_KINDS`（`--only` の項目の検査）、`parseStatusArgs`、`pickFields`、`formatStatus` は CLI に残す
- **組み立ては `src/board/composition.ts` に置く。** `assembleBoard(paths, store, runner)` が、PR の状態の取得元と控え・PR 番号の書き戻しを組んで `refresh()` を 1 回待ち、
  `getBoardQuery` / `getStatusQuery` / `decide`（`createDecideCommands`）を返す。`decide` の `cards` は `store.dataDir` のカードの依存から、要るものだけを渡す。
  データ用ブランチの取り直し（`store.refresh()`）とその失敗の出力は、今と同じく `cli-main.ts` が行う
- **`card` の書き込みの usecase。** `createCardWriteCommands(store, cards)` が、`create` / `replaceBody` / `linkBranch` / `submit` / `hold` を返す。
  どれもカードの usecase を `transactCardWrite` の中で呼び、コミットのメッセージを決める。文は今と同じ（`data: <id> を作る`、`data: <id> の本文を差し替える`、`data: <id> にブランチを紐付ける` / `data: <id> のブランチを外す`、`data: <id> に <gate> 提出|再提出|保留 を足す`）。
  `seed` は 1 枚ずつ `create` を呼ぶ（1 枚 1 コミットは今と同じ）
- **ブランチの紐付けの usecase。** `createLinkCardBranchCommand(cardRepository)` が `{ id, branch: string | null }` を受け、`branch` だけを書き換える（人に判断してほしいこと）
- **`card` の CLI の依存。** `CardCliDependencies` を `{ store: Pick<DataStore, 'refresh'>; cards: Pick<CardDependencies, 'cardRepository'>; writes: CardWriteCommands }` にする。
  `writes` に人の判断を書く口（`appendReviewCommand`・`startedAt` / `skipGates` を書ける `updateCardMetaCommand`）は無く、`CardWriteCommands` の型にも入れない。
  CLAUDE.md の書き込み境界の段落は、この形（`CardCliDependencies.writes`）を指すように直す
- **既存の CLI のテストの期待値は変えない。** `decide-cli.test.ts` / `status-cli.test.ts` / `card-cli.test.ts` の期待する出力・終了コード・コミットのメッセージが、振る舞いを変えないことの網になる。
  変えるのは依存の組み方（新しい usecase と query を組むヘルパー）と、型の import の行だけにする。移した段取りのテストは usecase と query の側に足す

### 仮定

- **手順書の版は上げない。** 根拠: `.claude/` のファイルは変えず、CLI の出力も変えない。手順書が読む `status --json` の形と、`decide` / `card` の出力は同じである（`.claude/HARNESS_VERSIONS.md` の「振る舞いの変わらない変更では上げない」）
- **ADR は書き直さない。** 根拠: `docs/adr/` に `decide-cli` / `status-cli` / `cli-main` / `assembleBoard` / `CardCliDependencies` / `transactCardWrite` を名指す文は無い（grep で確かめた）。
  ADR 0010 の「取り直して検査からやり直す」は、usecase に移っても同じに守る
- **`REVIEW.md` は直さない。** 根拠: 名指しているのは `src/cards/cli/card-cli.ts` に人の判断の入口を足すことへの注意で、ファイルの役目は変わらない
- **`board/composition.ts` が `cards/composition.ts` を import してよい。** 根拠: 今も `decide-cli.ts` と `cli-main.ts` がカードの依存をボードの組み立てに渡している。向きは board → cards の一方だけで、循環しない
- **画面を作り直すときの、常駐するサーバでのロックと取り直しは、今の `transact` のまま使える。** 根拠: カードの探索メモの見込み。このカードでは決めない

### 退けた代案

- `decide` の usecase をカードのコンテキスト（`src/cards/usecases/`）に置く: 検査に導出したボードが要り、ボードのコンテキストに依る。カードの指定どおり `src/board/usecases/commands/` に置く
- 書いた後の列の読み直しを CLI に残す: 画面と API も「何が書けて、列がどう移ったか」を同じ形で返したい。読み直しも段取りなので usecase に入れる
- `transactCardWrite` を `src/shared/` に置く: `CardWriteRefusedError`（カードのリポジトリの例外）を知っているので、カードのコンテキストに置く
- `card` の読む口（`list` / `show`）も query にする: 中身はリポジトリを読んで出すだけで、段取りが無い（人に判断してほしいこと）
- 読み飛ばしの警告の重複をこのカードで直す: 標準エラーの出力が変わり、「出力を変えない」と食い違う（人に判断してほしいこと）
- 紐付けを `updateCardMetaCommand` のまま `writes.linkBranch` の中で使う: CLI の依存からは消えるが、`card` の書き込みの口の作りから `startedAt` を書ける形が見えにくく残る。専用の usecase のほうが境界が型で読める（人に判断してほしいこと）

### Risks / Trade-offs

- 移す行が多い（`decide-cli.ts` 約 250 行、`status-cli.ts` 約 100 行、`cli-main.ts` 約 40 行、`card-cli.ts` 約 60 行）。振る舞いを変えないことは、既存の CLI のテストの期待値と、動作確認での古いビルドとの出力の比べで確かめる
- `decide` の usecase は `loadBoard` を `transact` の中と後で 2 回呼ぶ。今の `decide()` と `reportWrite()` と同じ回数で、増えない
- 型の移動で、`status-cli.ts` から `StatusReport` を import している箇所（テスト）の import が変わる。外のリポジトリから import する者はいない（npm に出していない）

### Non-Goals

- CLI の出力・終了コード・コミットのメッセージを変えない
- 読み飛ばしの警告の重複を直さない（人に判断してほしいこと）
- `card` の読む口（`list` / `show` / `seed` の既にある ID の確かめ）を query にしない。`loop` / `pr` / `init` / `dist-check` の CLI に触らない（人に判断してほしいこと）
- 常駐するサーバでのロックと取り直し、GitHub をどこから引くか、`127.0.0.1` への bind、エラーを HTTP のステータスへ変えることは決めない（画面を作り直すときに決める）
- 導出（`stage-resolver.ts`）・検査（`decision-guards.ts`）・カードの usecase の中身を変えない

## 探索メモとの対応

| #   | 探索メモ（短い引用）                                                                                      | 反映した先                                                                                  | 反映しなかった理由                                                              |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | `card` の CLI に `updateCardMetaCommand` がまだ渡っていて…ブランチの紐付けを専用の usecase にすれば外せる | 人に判断してほしいこと、Decisions（ブランチの紐付けの usecase、`card` の CLI の依存）、節 4 |                                                                                 |
| 2   | `decide()` は `transact` の `op` の中でボードを導出するので…読み飛ばしの警告が…重ねて出る                 | 人に判断してほしいこと、退けた代案、Non-Goals                                               |                                                                                 |
| 3   | 常駐するサーバでのロックと取り直し                                                                        | 仮定                                                                                        | カードの指定で、画面を作り直すときに決める                                      |
| 4   | どこから GitHub を引くか、`127.0.0.1` にだけ bind すること                                                | Non-Goals                                                                                   | カードの指定で、画面を作り直すときに決める                                      |
| 5   | エラーを HTTP のステータスへ変えること                                                                    | Non-Goals                                                                                   | カードの指定で、画面を作り直すときに決める（人に読める文への直しは CLI に残す） |

## 動作確認の手順

振る舞いを変えないことを、`origin/main` のビルド（以下、古いビルド）と、このブランチのビルド（以下、新しいビルド）の出力を比べて確かめる。
古いビルドは、`$MAIN` をスクラッチパッドへ clone して `origin/main` をビルドしたものを使う（`$MAIN/dist` は後で更新されうるので使わない）。

共有の `origin` の `ai-board/data` に書かないよう、本物のデータ用ブランチをスクラッチパッドへ bare で clone する。
それを `origin` にした clone を 2 つ作り、古いビルドと新しいビルドに 1 つずつ `AI_BOARD_DATA` で指させる（共通の決まりの「動かして確かめるとき」）。
2 つの bare は同じ時点の clone から作り、同じ状態から始める。

```bash
S=<スクラッチパッドの下の作業用ディレクトリ>
git clone --bare --branch ai-board/data git@github.com:iepyon/ai-board.git "$S/seed.git"
for v in old new; do
  git clone --bare "$S/seed.git" "$S/$v/origin.git"
  git clone --branch ai-board/data "$S/$v/origin.git" "$S/$v/data"
done
git clone "$MAIN" "$S/base" && git -C "$S/base" checkout origin/main && (cd "$S/base" && npm ci && npm run build)
OLD="$S/base/dist/cli.js"; NEW="$WT/dist/cli.js"
```

同じ手順を `AI_BOARD_DATA="$S/old/data" node "$OLD" ...` と `AI_BOARD_DATA="$S/new/data" node "$NEW" ...` で走らせる。
各コマンドの標準出力・標準エラー・終了コードをファイルに取り、最後に `git -C "$S/<v>/data" log --format=%s` を取って、old と new を `diff` で比べる。
試しのカードは `try-orch` を使い、計画レビューまで立てるときは `$WT/.ai-board/plans/try-orch.md` を一時的に置く（確かめ終えたら消し、コミットしない）。

| 確かめること                                        | コマンド                                                                                                                                                                    | 期待する結果                                                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `status --json` が同じ                              | `status --json --root "$WT"` を old / new で取り、`generatedAt` を除いて比べる                                                                                              | 差分が無い                                                                                                                        |
| `status` の人向けの出力と `--only` が同じ           | `status --root "$WT"`、`status --json --only next,waiting,cards.id --root "$WT"`                                                                                            | 差分が無い                                                                                                                        |
| `card` の書き込みの出力とコミットのメッセージが同じ | `card create --title t --id try-orch`、`card body try-orch`、`card branch try-orch b` / `--clear`、`card submit try-orch`（着手の前で拒まれる）                             | 標準出力・標準エラー・終了コード・`git log --format=%s` に差分が無い                                                              |
| `decide` の出力とコミットのメッセージが同じ         | `decide start try-orch` → 計画を置いて `card submit try-orch` → `decide reject try-orch --reason r` → `card hold try-orch --gate plan --reason h` → `decide abort try-orch` | 同上。`decide` の 1 行（`try-orch: 着手 を書きました（アイデア → 計画提案中）` など）も同じ                                       |
| `decide` の拒否の文が同じ                           | `decide approve try-orch`（出せない判断）、`decide reject try-orch`（理由なし）、`decide move try-orch --after try-orch --before none`                                      | 同上                                                                                                                              |
| `decide` の並べ替えが同じ                           | `decide move try-orch --after none --before <先頭のアイデア>`、`decide move-divider --after none --before <先頭のアイデア>`                                                 | 同上                                                                                                                              |
| `card` の CLI の依存に人の判断を書く口が無い        | `grep -n "appendReviewCommand\|updateCardMetaCommand" src/cards/cli/card-cli.ts`                                                                                            | 何も出ない                                                                                                                        |
| 品質ゲート                                          | `npm run typecheck && npm run lint && npm run format:check && npm test`                                                                                                     | 通る。既存の CLI のテストの期待値を変えていない（`git diff origin/main -- 'src/**/cli/__tests__/'` が依存の組み方と import だけ） |
| 本物のデータ用ブランチに書いていない                | `git -C "$MAIN/.ai-board/data" log origin/ai-board/data --since=<確かめを始めた時刻> --format=%s`                                                                           | 試しのカード `try-orch` のコミットが無い                                                                                          |

## タスク

### 1. 書き込みの包み方と、ボードの組み立てを移す

- [x] `transactCardWrite` を `src/cards/usecases/commands/transact-card-write.ts` へ移し、`cards/composition.ts`・`decide-cli.ts`・`card-cli.ts` の import を直す。`card-errors.ts` の `CardWriteFailure` の説明を直す
- [x] `cli-main.ts` の `assembleBoard` を `src/board/composition.ts` へ移す。`status` と `decide` は、取り直しの後にこれを呼ぶだけにする（この節では、返すものは今の `BoardDependencies` のまま）

### 2. `status` の見せる形を query にする

- [x] `StatusReport` / `WaitingCard` / `WorkingCard` / `StatusCard` / `IdeaListRow` を `src/board/models/status-report.ts` へ移す
- [x] `buildStatusReport` と `withImplStep` を、`src/board/usecases/queries/get-status.query.ts` の `createGetStatusQuery` にする。`status-cli.ts` の依存を `{ getStatusQuery }` にし、整形だけを残す
- [x] `assembleBoard` が `getStatusQuery`（カードのブランチの計画の読み手を含む）を返すようにし、`cli-main.ts` の `runStatus` を直す
- [x] `status-cli.test.ts` の依存の組み方と `StatusReport` の import を直す（期待値は変えない）。`src/board/usecases/__tests__/get-status.query.test.ts` に、`next.step` を埋める場合と埋めない場合のテストを足す

### 3. `decide` の段取りを usecase にする

- [x] `DecideError`（と `BoardUnreadable`）を `src/board/errors/board-errors.ts` へ移して export する
- [x] `src/board/usecases/commands/decide.command.ts` に `createDecideCommands` を作り、`decide()` と `reportWrite()` の段取り（導出・検査・書き込み・コミットのメッセージ・書いた後の列）を移す
- [x] `decide-cli.ts` の依存を `{ decide: DecideCommands }` にし、引数の解析と、結果とエラーを文に直すことだけを残す
- [x] `assembleBoard` が `decide` を返すようにし、`cli-main.ts` の `runDecide` を直す
- [x] `decide-cli.test.ts` の依存の組み方を直す（期待値は変えない）。`src/board/usecases/__tests__/decide.command.test.ts` に、書いた後の列（`to`）が読めない場合に null を返すことと、push の拒否でボードを導き直して検査からやり直すことのテストを足す

### 4. `card` のコミットのメッセージを usecase へ寄せる

- [ ] `src/cards/usecases/commands/link-card-branch.command.ts` にブランチの紐付けの usecase を作る
- [ ] `src/cards/usecases/commands/card-write.commands.ts` に `createCardWriteCommands`（`create` / `replaceBody` / `linkBranch` / `submit` / `hold`）を作り、コミットのメッセージを移す
- [ ] `CardCliDependencies` を `{ store: Pick<DataStore, 'refresh'>; cards: Pick<CardDependencies, 'cardRepository'>; writes }` にし、`card-cli.ts` の書き込みを `writes` 経由にする。`cards/composition.ts` に組み立てを足し、`cli-main.ts` の `runCard` を直す
- [ ] `card-cli.test.ts` の依存の組み方を直す（期待値は変えない）。`src/cards/usecases/__tests__/` に、紐付けの usecase と、書き込みの usecase がコミットのメッセージを決めることのテストを足す

### 5. 文書を今の形に直す

- [ ] `CLAUDE.md` の書き込み境界の段落（`CardCliDependencies.cards` と `appendReviewCommand`）を、`CardCliDependencies.writes` の形に直す
- [ ] `docs/architecture.md` の、`card-cli.ts` の依存・`decide-cli.ts` の段取り・`status-cli.ts` の `next.step` と `pickFields` を書いた箇所を、usecase と query の名前に直す
