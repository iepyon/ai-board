# 実装の細部

`CLAUDE.md` から移した、触る箇所に応じて読めばよい細部。
不変条件とハードルールは `CLAUDE.md`、使い方と 1 周の流れは `README.md`、なぜそう作ったかは `docs/adr/` にある。

## ディレクトリ

```
src/
  app.ts                Express アプリケーションファクトリ
  server.ts / cli.ts    起動（cli.ts は引数解析とブラウザ起動）
  shared/               Result<T,E>・Branded Types・設定・ミドルウェア
  cards/                カードの CRUD コンテキスト
  board/                3ソース統合・ステージ導出コンテキスト
  infrastructure/       ファイル監視・SSE・GitHub ポーリング
  web/                  React + Vite のダッシュボード UI
```

各コンテキストは `models/ errors/ repositories/ usecases/ controllers/ composition.ts` を持つ。

## ゲートの状態

ゲートの状態は `src/cards/services/review-log.ts` が本文の `## レビュー` から読む。
ゲートは計画を読む `plan` の 1 つ（`REVIEW_GATES`）。
廃止した `explore` / `verify` のエントリは規定外として黙って無視される（`RETIRED_REVIEW_GATES`）。
判断のファイル（`log/`）の名前が廃止したゲートのものなら、壊れたファイルの警告を出さずに読み飛ばす（`card-files.ts` の `isRetiredLogFileName`）。
frontmatter の `skipGates` に残る廃止したゲートは、読むスキーマ（`card.schema.ts`）が検証の前に落とす。書く `PATCH` は `plan` だけを受け付ける。

`gateState()` はゲートごとの最新エントリ 1 件で決まり、中止のエントリは判定から除く
（中止は工程の進捗と直交する終端の軸で、通過済みのゲートを巻き戻さない）。
状態は `none` / `submitted` / `held` / `approved` / `rejected` の 5 つで、`held` は最新が 保留 のとき。
どの規則も `held` でゲートを先へ進めないので、保留のカードは AI の列（計画提案中 / 実装中）に留まり、`hold` が立つ。
飛ばす宣言（`skipGates`）のあるゲートでは、最新が 提出 / 再提出 なら `approved` と読む（AI の提出を人の承認と同じに読む）。
宣言があってもログを見ずに通過扱いにはしないので、エントリが無ければ `none` で、否決 / 保留 / 承認 はふつうに効く。
このため plan を飛ばすカードも、着手するまではアイデアに留まり、着手すると計画提案中に入って計画を書く手（`plan`）が渡される。
読み替えはエントリの種別を書き換えないので、`approved` が人の承認か AI の提出かは、`latestGateEntry` が返すエントリの種別で見分ける。

全ゲートの状態は `gateStates()` でまとめて引く（`toFacts` と CLI の `planApproved` が使う）。
`latestGateEntry` はゲート（省けばゲートを問わず）の中止を除いた最新のエントリを返す。

判断待ちの区画が出す提出の本文と待ち始めた時刻は、`latestReview` から取る。
`latestReview` は「その列が待っているゲート（`GATE_OF_STAGE`）の最新エントリ、無ければゲートを通じた最新」で、
どのゲートのものかを `gate` に持つ。

## 差し戻しと Draft の PR

否決の差し戻しに専用ルールは無い。ゲートが差し戻し中のときレビュー行と承認行が両方外れ、
1 つ手前の AI 列へ自然に落ちる。

「計画から立て直させる」は承認済みの計画への plan 否決で、専用の規則もエントリも無い。
plan が `rejected` になって 計画提案中 に落ち、ループは `revise-plan` を選ぶ。
計画を承認し直すと（plan を飛ばすカードでは計画を再提出すると）実装中へ戻り、ループは `implement` から始め直す。

計画ファイルはブランチにあり、ボードを動かすチェックアウトからは見えないことが多いので、
Draft の PR も計画レビューの列を立てる。AI が締めの段で Ready にした時点で PR中 へ進む。
実装中の PR も Draft のままだが、Draft の PR が立てる計画レビューのルールは plan が未承認のときにしか
当てはまらないので、計画レビューへは巻き戻らない。

`draft` だけでは「まだ一度も Ready にしていない」と「人が Draft に戻した」を見分けられない。
そこで PR が最後に Draft へ戻された時刻を `MrState.convertedToDraftAt` に持つ（GitHub の `convert_to_draft` のイベント）。
作成時から Draft の PR はこのイベントを残さないので、値が入っていれば誰かが Ready の PR を Draft に戻したことを意味する。
実装中のカードでこの時刻が最新のレビューエントリより新しければ止まり（`hold`）になり、ループは Ready にし直さない。
人が GitHub で Ready に戻すか（PR中 へ進む）、ボタンで否決・中止すれば（そのエントリが新しくなる）止まりは外れる。

## 止まり（hold）

AI の列（計画提案中 / 実装中）にいても、人の判断を待って止まっているカードはループが選ばない。
止まりは `resolveHold` が導き、ボードの組み立て（`get-board.query.ts`）で `BoardCard.hold`（`{ reason, since }` か `null`）に載る。
ステージとは別の軸の派生値で、どこにも保存しない（ステージは「工程のどこにいるか」、止まりは「その工程で誰を待っているか」）。
止まりは次の 3 つで、`reason` には人が何をすればよいかを書く（`HOLD_REASONS`）。

- 実装中で、人の最新の判断より後に PR が Draft に戻された（`mrState.convertedToDraftAt`）。
  AI が Ready にした PR を人が Draft に戻すとカードは実装中に落ち、計画は archive 済みなので、見ないと `implement` の archive 済みの段が Ready にし直してしまう
- 計画提案中で、plan の最新が 保留
- 計画提案中で、plan が提出済みなのに計画ファイルも Draft の PR も見えない（作り直すと PR を二重に作りかねない）。
  PR の状態を引けていない（取得先に未接続、または起動直後で初回の取得前。`MrStateProvider.synced`）ときは、
  PR が無いのか分からないので立てない

人が承認 / 否決 / 中止を書けばそのエントリが最新になり、止まりは外れる。止まりを解く専用のエントリは無い。

## 判断のボタンと画面の区画

CLI（`src/cards/cli/card-cli.ts`）には `startedAt` / `rank` / `skipGates` を書く入口も、承認 / 否決 / 中止を追記する入口も無く、
`body` は `## レビュー` のエントリが変わる差し替えを拒む。
`submit` の plan ゲートは、着手したカードで、plan が未提出か否決のときにだけ書ける
（plan を飛ばすカードの `plan 再提出` は承認と読まれるので、いつでも書けると人の否決や保留を経ずに計画を出し直せてしまう）。
`submit` / `hold` の `--gate` は `plan` だけを受け、廃止した `verify` は使い方の誤りとして拒む。
逆に人の API（`POST /api/cards/:id/reviews`）は `HUMAN_REVIEW_KINDS`（承認 / 否決 / 中止）だけを受け、提出 / 再提出 / 保留 は 400 で拒む。

判断の追記と本文の保存は、リポジトリ（`CardRepository`）の別の口に分かれており、判断は文字列を経由せずに値のまま書く。
判断を偽造させないのは入口ごとの検査ではなく、この作りである。CLI と API のどちらから書いても同じに効く。

人の判断の CLI（`src/board/cli/decide-cli.ts`、`ai-board decide`）は、人の API と同じ usecase を、サーバと同じ組み立て（`createTransactionalCardDependencies`）で呼ぶ。
書く前に `status` と同じ組み立てでボードを導出し、画面で押せる判断かを確かめる。
承認 / 否決 / 中止は `decisionsFor` にあるもの、着手 / 着手を戻すは今の列と `droppableStages`、並べ替えはアイデアの表（`ideaRows`）にあるカードだけを書く。
GitHub に接続できないときは承認 / 否決 / 中止と着手 / 着手を戻すを拒む（`status` が `next` を `null` にするのと同じ理由。列と下限が PR の状態に依るため）。
書いた後は、取り直した PR の状態のままボードを組み立て直し、列の移りを 1 行で出す。
`ai-board decide` を誰が呼んでよいかは構造では分けず、手順書の決まり（人がこの会話で頼んだときだけ）で守る（ADR 0007）。

- **判断は値のまま 1 件だけ足す。** `createAppendReviewCommand` は判断（時刻・gate・種別・理由）をリポジトリの `appendReview` に渡し、
  `log/` に判断のファイルを 1 つ書く（ファイル名と中身は `card-files.ts` の `planReviewAppend` が決める）。`card.md` には触らない。
  理由はファイルの中身になるだけで、見出しとして読み直さない。理由に `### <時刻> <gate> <種別>` の形の行があっても拒まず、
  判断は指定した 1 件だけが増える。その行は組み立てるときに `####` へ下がり、理由の一部として見える
- **本文の保存は判断を作らない。** `save`（`planCardWrite`）は本文とメタ（と着手）だけを書き、判断のファイルを決して作らない。
  本文の `## レビュー` の節は次の 2 つで読む（節があるかは `review-log.ts` の `hasReviewSection`）
  - 節が無い（画面の本文の編集が送る形）: 判断は変えないと読み、本文をそのまま `card.md` に書く。判断は `log/` にあり、本文の保存はそこに触らないので消えない
  - 節がある（CLI で `card show` の出力を直して送る形など）: `parseReviewLog` で読んだエントリが今と同じなら、節を除いた本文を書く。
    違えば（末尾に判断の見出しを足しただけの本文も、今の判断があるカードにエントリの無い `## レビュー` の見出しだけを送る本文も）、書かずに `ReviewEntriesChanged` で拒む
- **本文の差し替えで `## レビュー` のエントリを変えられない。** `createUpdateCardBodyCommand` も同じ 2 つの読み方で書く前に比べ、節があってエントリが違えば `ReviewEntriesChanged` を返す。
  CLI の `body` は 1 で終わり、API（`PUT /api/cards/:id/body`）は 409（`REVIEW_ENTRIES_CHANGED`）を返す。節の無い本文はどちらも受け付ける。
  リポジトリの拒否は保存の拒否（`CardWriteRefused`）になるので、人に「判断は判断のボタンから足す」と返すのは usecase の役目である。
  保存した後は `findById` で読み直して返す（節の無い本文から作った `Card` をそのまま返すと、応答の `reviews` が空になるため）

どのカードにどの判断のボタンを出すかは `src/shared/dashboard-sections.ts` の `decisionsFor` が決める。

| カード                                       | ボタン                                  |
| -------------------------------------------- | --------------------------------------- |
| 計画レビュー                                 | 承認 / 否決して差し戻す / 中止          |
| 実装中で止まっている（Draft へ戻された）     | 計画から立て直させる（plan 否決）/ 中止 |
| 計画提案中で止まっている（plan 保留）        | 計画を直させる（plan 否決）/ 中止       |
| 計画提案中で止まっている（成果物が見えない） | 中止                                    |

どのボタンも plan のゲートに書く（中止も plan に書く。中止はゲートを問わず最新のエントリで読む）。

飛ばす宣言（`skipGates`）の有無では出し分けない。宣言のあるゲートでも、人の否決 / 承認はふつうに効くからである（`gateState`）。
plan を飛ばすカードが実装中で止まっても「計画から立て直させる」を出す。
判断待ちのボタンを本文より前に出すか（`awaitsDecision`）は、`decisionsFor` が 1 つでも返すかで決まる。

UI が `startedAt` を書き換えるのは「着手」「着手を戻す」のボタンだけ。列をまたぐドラッグは無く、
ドラッグはアイデアの表の中の並べ替え（`rank`）と区切り線の移動にだけ使う。
`skipGates` を画面から書くのは、詳細パネルのゲートの欄の「計画レビューを飛ばす」（`plan` の出し入れ）のチェックボックスだけ（`SkipGateField`）。
`withSkipGate` で 1 つのゲートだけを出し入れする。`ai-board card` には入口を足さない（人の判断の `ai-board decide skip` も `withSkipGate` を使う）。
提出済みのカードに「計画レビューを飛ばす」を入れると、`plan 提出` が承認と読まれてその場で実装中へ進む。

画面の区画（判断待ち / AI 作業中 / アイデア / マージ済み / 中止）への振り分けと並び順も `dashboard-sections.ts` の純関数にある。
ステージの導出とは別物で、見せ方だけを決める。
`hold` のあるカードはステージが AI の列のままでも判断待ちの区画に入り、待ち始めた時刻（`waitingSince`）は `hold.since` になる。
逆に PR中 のカードでも、人の指摘に AI が応える番（`mrState.awaitingFix`）なら AI 作業中の区画の先頭に入る（`isAwaitingPrFix`）。
「`startedAt` を外したときに残るステージ」（AI の成果物とレビュー記録が課す下限）より
前へは戻せない（`resolveFloorStage` / `droppableStages`）。

アイデアの表の区切り線は `rank` と同じ物差しの値を 1 つだけ持つ（データ用ブランチの `order.yaml` の `divider`）。
並べ替えの中ではカードと同じ 1 項目（`DIVIDER_ID`）として扱い、隙間が尽きた振り直しでも一緒に振り直す
（`src/cards/usecases/commands/move-in-order.ts`）。

## `ai-board status` と次の一手

`status` はサーバを起動せず、ボードと同じ組み立て（`createMrStateSource` → `getBoardQuery`）でステージを導出する。
PR の状態は `refresh()` を 1 回だけ待って引き、`branch` から解決した PR 番号の書き戻しもサーバと同じく起きる。

次の一手は `src/board/services/next-action.ts` の `pickNextAction`（PR中 → 実装中 → 計画提案中、列の中は `rank` の順）が決める。
手は `plan` / `revise-plan`（計画提案中）と `implement`（実装中）と `fix-pr`（PR中）の 4 種類で、止まっていない実装中のカードには常に `implement` を返す。
PR中 のカードは人の列なので、`mrState.awaitingFix`（下の「PR の指摘に AI が応える番」）が真のものだけを `fix-pr` で選ぶ。
締めの段が動かした証拠を PR の本文に書いて Ready にするので、Ready にするための別の手は無い。
ループの 1 手の記録（`loop/`）に残る廃止した手（`revise-impl` / `ready`）は、`LOOP_PAST_ACTIONS` として読めるまま残し、`loop start` では受け付けない。
`implement` は手の種類を計画の進み具合では分けず、段を `next.step` として添える（`implement` 以外の手では常に `null`）。
`pickNextAction` は純関数のまま `step: null` を返し、`status-cli.ts` が `implement` のときだけ、選ばれた 1 枚のカードのブランチの計画を読んで埋める。

- 読み方: `src/board/repositories/` の読み手が `CliRunner` で `git show <ref>:.ai-board/plans/<id>.md` を、無ければ `plans/archive/<id>.md` を読む。
  `<ref>` はローカルの `refs/heads/<branch>` があればそれ、無ければ `refs/remotes/origin/<branch>`。
  `branch` は誰でも書けるので完全な ref 名にして渡し、`git check-ref-format --branch` を通らない名前では `git` を呼ばない。`git fetch` はしない
- 段: `src/board/services/impl-step.ts` の `resolveImplStep` が決める。archive 済み → `close`、未チェックのタスクがある → `task`、
  全部倒れていて `## AI レビュー` 節（コードブロックの外の見出し）が無い → `review`、ある → `close`。
  タスクの行の正規表現と、フェンス（` ``` ` / `~~~`）で囲んだコードブロックの中の行を外す純関数（`src/board/models/plan-task.ts` の `linesOutsideCodeBlocks`）を
  進捗バー（`plan.repository.ts`）と共有する。コードブロックの中のチェックボックスと見出しは数えない。閉じていないフェンスは無いものとして後ろの行を数える
- 読めない（`branch` が null、ブランチや計画が無い、`git` が失敗した）ときは例外を投げず `step` を `null` にし、`status` 自体は成功させる。
  人向けの数行（`--json` を付けない形）では `段=task` のように添え、`null` は `段=不明` と出す（`status-describe.ts`）
- ループ（本筋のセッション）は、`review` なら `board-reviewer` のサブエージェントを前景で立て、`task` / `close` / `null` なら `board-loop` の `implement.md` の手順で自分で進める。
  段はステージではなく、サーバ（`GetBoardQuery`）とステージの導出（`stage-resolver.ts`）はブランチの計画を読まない
  GitHub に接続できないとき（`forge.status` が `connected` でないとき）は `next` を `null` にする。

`status` の `waiting` は画面の判断待ちの区画（`groupBySection` の inbox）をそのまま使うので、止まっているカードも 1 度だけ出て、`working` には出ない。
人の指摘に AI が応える番の PR中 のカードは逆に `working` の先頭に出て、`waiting` には出ない。
止まっているカードの `reason` は `hold.reason` になる。
`waiting` の各カードは、画面がボタンとして出す判断（`decisionsFor`）を `decisions` に持つ。
`status --json` は、ほかにアイデアの表の並び（`ideas`。画面と同じ `ideaRows` の順で、区切り線も 1 行）と、
同じデータのワークツリーを使って起動中のサーバの URL（`server`。無ければ `null`）を出す。`ideas` は `board-decide` のスキルが並べ替えの位置を選ぶのに使う。

`status --json --only <項目,...>` は、出力を組み立てた後に、コンマ区切りの項目だけに絞る（`status-cli.ts` の `pickFields`）。
項目は `<key>`（最上位の項目をそのまま）か `<key>.<field>`（最上位の配列の各要素から `<field>` だけ）で、`.` の入れ子は 1 段まで。
無い最上位の項目、配列でない項目への `.`、2 段以上の `.`、`--json` 以外との組み合わせは、使い方の誤りとして GitHub に問い合わせる前に失敗する。
要素に無い `<field>` は、その要素では出さない。手順書（`board-loop` / `board-decide`）が `jq` の代わりに使う。

サーバは起動中の自分の場所（URL・pid・データのワークツリーのパス `dataDir`）を、データのワークツリーの親の `server.json` に書き、止まるときに消す
（`src/infrastructure/server-info.ts`。git には載せない）。`status` はこれを読み、`dataDir` が一致し pid が生きているときだけ `server` に URL を出す。

Windows の `process.kill(pid, 'SIGTERM')` は強制終了になり `server.json` が残るが、上のとおり pid が生きていなければ `server` に出ない。

### `status --html`（ダッシュボード）

`status --html` はボードを 1 枚の自己完結の HTML（ダッシュボード）にする（`src/board/cli/status-html.ts`）。`board-dashboard` のスキルが Artifact として公開する。

- 頭（生成の時刻・ループ・次の一手・更新ボタン）の下を、今 / ログ / 振り返り の 3 つのタブに分ける。
  タブはラジオボタンと CSS だけで切り替え、スクリプトを使わない（`--session` の無いページにスクリプトを入れないため）
- 今のタブには、画面と同じ振り分け（`groupBySection`）で判断待ち・AI 作業中（ループが触っていれば今の手）・アイデア（`ideaRows` の並びと区切り線）を並べる
- ログのタブには、全カードのループの手（`loopSteps`）と判断の記録（`reviews`）を、`src/shared/board-log.ts` の `buildBoardLog`（純関数）で新しい順の 1 本にして出す。
  多くても `BOARD_LOG_LIMIT`（200）件で、省いた件数を添える。手の中の動き（コミットやコマンド）はボードのデータに無いので出せない
- 振り返りのタブの頭に集計を置く。集計は `src/shared/board-metrics.ts` の `computeBoardMetrics`（純関数。今の時刻は読まない。区間を数えるのはマージ済みのカードだけで、閉じていない区間はマージの時刻（無ければ計画の最終更新）で閉じ、どちらも無いカードは工程と人の番の割合から除く。中止したカードは入れない）。
  主な数字・工程ごとの滞在時間（マージ済みのカードごとに同じ種類の区間を足し、カードを並べた中央値。いちばん長い工程がボトルネック）・日ごとのマージ数（UTC の日付）・
  ループの手の種類ごとの回数と平均（`durationMs` / `tokens` が null の記録は除き、除いた件数を出す）・手の結果の内訳を出す
- グラフは `src/board/cli/status-charts.ts` がインラインの SVG の文字列として描く。外部のスクリプトを読まず、色は `:root` のトークンを class で指す
- 集計の下に、マージ済み・中止の区画を並べる。
  PR のリンクは `PR_LINK_ATTRIBUTES`（`target="_top"`）で開き、URL を文字でも出す
- 設定に `github.repository` があれば、カードのタイトルを `cardUrl` の指す GitHub 上のデータ用ブランチのカードのファイル
  （`https://github.com/<owner>/<repo>/blob/ai-board/data/cards/<id>/card.md`）へのリンクにする（同じ `PR_LINK_ATTRIBUTES` で開く）
- `--session <id>`（`session_` に英数字。`--html` のときだけ）を渡すと、更新ボタンとスクリプトが入る。
  スクリプトは `claude.use("mcp")` で `Claude Code Remote` の `send_message` を呼び、埋め込んだセッションに `REFRESH_MESSAGE` を送るだけである。
  値は JSON にして `<` を逃がして埋め込む。`mcp` が使えない・呼べないときはボタンを隠し、チャットで頼む案内を出す。頼んで 3 分たっても読み直されなければボタンを戻す
- `--session` が無ければスクリプトもボタンも入れない。判断のボタンはどちらでも置かない（[ADR 0015](adr/0015-dashboard-refresh-via-session.md)）

## カードの保存と通知

カードの正本は、`origin` の orphan のブランチ `ai-board/data`（データ用ブランチ）にある。コードの履歴とは交わらない。
中身は次のとおり（形は `src/cards/repositories/card-files.ts` の純関数が読み書きする）。

```
ai-board-data.yaml                      形の版（version: 1）。CLI はこれより新しい版を読まずに止まる
config.yaml                             GitHub の接続設定（ai-board init が .ai-board/config.yaml を写す）
order.yaml                              rank とアイデアの区切り線（{ divider, ranks: { <id>: <数> } }）
cards/<id>/card.md                      frontmatter（id, title, created, skipGates, branch, mr）と本文
cards/<id>/log/<時刻>.<gate>.<種別>.md   判断 1 件。中身は理由の本文。追記だけで、書き換えも削除もしない
snapshots/<id>.json                     マージ済みの PR の控え
loop/<時刻>.<ループの識別子>.json        ループの 1 手の記録（後述の「ループの 1 手の記録」）。カードではない
```

`card show` の出力（`card.md`・`log/`・`order.yaml` から組み立てた `Card` を frontmatter の形で表したもの）:

```yaml
---
id: board-search # 不変。生成後は変えない。ディレクトリ名と一致する kebab-case
title: カードを絞り込めるようにする
created: '2026-09-04T06:48:23.416Z'
startedAt: null # 人が着手を指示した時刻（人が打つ）。log/ の着手・着手を戻すの最新から組み立てる
skipGates: [] # 人が事前に見ないと宣言したゲート（plan）
branch: null
mr: null # レビュー要求の番号（branch から自動解決して書き戻す）
rank: 1500 # 並び順（任意）。小さいほど上。人が並べ替えたときだけ order.yaml に書かれる
---
```

本文の `## レビュー` の節は `log/` の判断のファイルから組み立て、本文の末尾に付ける（`card.md` の本文にあっても読まない）。
理由の中の `#` で始まる見出しは、節を途中で切らないよう `####` へ下げて組み立てる。
`card.md` が読めない、frontmatter の項目が不正、`id` がディレクトリ名と食い違う、のどれかなら、そのカードは警告して読み飛ばす。
Markdown 表現（`card-markdown.ts`）は `card show` の出力にだけ使う。

**置き場所。** 手元では、メインのチェックアウトの `.ai-board/data/` に `git worktree add` でデータ用ブランチのワークツリー
（データのワークツリー、`dataDir`）を 1 か所置く。`sharedBoardDir` はリンクされたワークツリーからもメインの `.ai-board/` に解決されるので、
どのワークツリーから動かしても同じ場所になる。無ければ CLI とサーバが最初に作る。
データ用ブランチが `origin` に無ければ止まり、空のデータ用ブランチを作る `ai-board init`（`src/cards/cli/init-cli.ts`）を案内する。
`AI_BOARD_DATA` を指すと、データのワークツリーの代わりにそのディレクトリ（git のリポジトリ）を使い、その `origin` に push する。
試すときはスクラッチパッドの bare リポジトリを `origin` にした clone を指す。
`server.json`・ロック（`data.lock`）・開いている PR の控え（`cache/`）は、どれも `dataDir` の親に置き、git に載せない
（既定なら `.ai-board/` の下、`AI_BOARD_DATA` ならそのディレクトリの隣）。試しのデータが本物とロックや控えを共有しないためである。

**書き込み。** CLI とサーバの書き込みは、どれも `DataStore.transact`（`src/infrastructure/data-store.ts`）の 1 操作として走る。

1. ロックを取る（`data.lock` を排他作成。持ち主の pid が死んでいれば取り直す。5 秒待って取れなければ失敗）
2. 取り直す（`git fetch origin +refs/heads/ai-board/data:refs/remotes/origin/ai-board/data` → `reset --hard` → `clean`）
3. 操作を走らせる。usecase と CLI の検査（`submitRefusal` など）はこの中にあり、取り直した最新の状態に対して行われる。何も書かなければコミットしない
4. `git add -A` → `git commit`（メッセージは ID・ゲート・種別だけで、理由の文は入れない）→ `git push origin HEAD:refs/heads/ai-board/data`
5. push が拒否されたら、rebase せずに 2 に戻り、操作を頭からやり直す（3 回まで）

rebase しないのは、離れた行の編集を git が黙って混ぜ、検査を経ないままの状態が push されうるからである。
2 つの clone から同じカードに同時に `submit` を書いても、1 つだけが通り、後から来た方は取り直した状態で拒まれる。
git はすべて `cli-runner.ts` を通し、引数は配列で渡す。`origin` の無いデータのワークツリー（テスト用）では fetch と push を飛ばしてコミットだけする。

読み出しは、CLI のコマンドの頭とサーバの起動時に 1 回取り直す。fetch に失敗したら（オフライン）警告して手元の内容で読むが、書き込みは失敗にする。
画面の書き込みは push が終わるまで応答を待つ。push・fetch の失敗とロック待ちは 503、データ用ブランチが無いなどの置き場所の不備は 500、
判断のエントリを書き換える保存の拒否は 409 になる（`card-error-mappings.ts` の `mapCardWriteFailureToResponse`）。
usecase が書く前に拒むもの（本文の差し替えでエントリが変わるものは 409）と、判断の追記の口は、「判断のボタンと画面の区画」に書く。

**通知。** サーバは計画のディレクトリとデータのワークツリーを chokidar で見て（`src/infrastructure/watch.ts`）、変化を SSE 経由でブラウザへ知らせる。
`.git` の下、`data.lock`、`cache/`、`server.json` は見ない（カードの変化が無くても発火するため）。
ほかの場所（CLI、クラウドのセッション）からの書き込みは、PR のポーリングと同じ間隔（既定 60 秒）でデータ用ブランチを取り直して拾い
（`src/infrastructure/data-refresher.ts`）、取り直しで書き換わったファイルをファイル監視が拾う。
手元にしか無い変更は持たない前提なので、取り直しで失うものは無い。サーバ自身の書き込みは、push の後に `onWrite` からも知らせる。

移行前の `.ai-board/board.db`（SQLite）は、今の版では読まない。移行は SQLite を消す前の版（`d2380ce`）の `ai-board migrate` で行う（README の「board.db からの切り替え」）。

## GitHub の PR の取得

`config.yaml` に `github:` を書いたときだけ有効で、無ければ `PR中` / `マージ済み` の列が空になるだけでボードは動く。
`config.yaml` はデータ用ブランチの根から読み、無ければ `.ai-board/config.yaml` を読む（`src/shared/config.ts`）。
クラウドのセッションの clone には、git に載らない各自のファイルが無いからである。

`gh` で GitHub を引けるかは起動時に 1 度だけ確かめ（`ForgeClient.checkAuth`）、使えなければ理由付きで `disabled` にする。
確かめ方は `gh api repos/<owner>/<repo>` を 1 回引けるかで、`gh auth status` は使わない。
クラウドのセッションでは `gh auth status` が「GH_TOKEN が無効」と失敗するが、同じ認証で `gh api` は動く。
ポーリングで使うのも `gh api` なので、同じ経路で確かめる。`connected` にならないと `status` の `next` が `null` になり、ループが回らない。

GitHub の PR は `state` が `open` / `closed` の 2 値しかなく、**マージ済みも `closed`** で返る。
区別は `merged_at` の有無で付ける（`toLifecycleState`）。ここを取り違えるとカードが `merged` へ進まない。

レビューコメントは issue comment と review comment の 2 か所に分かれるため、合算して「人が書いた最新のコメント」とする。
どちらの一覧も既定は古い順の 1 ページ目だけで、`issues/{n}/comments` は `sort` /
`direction` を受け付けない（受けるのはリポジトリ単位の `issues/comments` の方）。
並び順に頼らず `gh api --paginate` で全ページ引いて最大値を取る。
最新コミットは `pulls/{n}/commits` ではなく `head.sha` を直接引く（件数で取り逃がさない）。
自動生成のコメントを示すフラグは無く、`user.type === 'Bot'` で外す。

### PR の指摘に AI が応える番

AI は PR もコメントも人のアカウントで書くので、ユーザーでは人と AI を見分けられない。
本文に Claude Code のフッター（`CLAUDE_CODE_FOOTER`、`_Generated by [Claude Code](https://claude.ai/code)_`）を含むコメントを AI のもの（`isAiComment`）とし、
人のコメントの件数と最新時刻（`noteCount` / `latestNoteAt`）から外して、最新時刻だけを `MrState.latestAiNoteAt` に持つ。
`ai-board pr comment` は本文にフッターが無ければ末尾に足す（`withClaudeCodeFooter`）。

`src/shared/pr-feedback.ts` の `awaitsPrFix` は、PR が Ready で開いていて、人の最新のコメントが最新コミットとも AI の最新のコメントとも後にあるときに真を返し、
ボードの組み立てで `BoardCardMr.awaitingFix` に載る。ステージの導出は読まず、PR中 のまま変わらない。
読むのは画面の区画（`groupBySection` が `work` の先頭へ寄せる。`SECTION_OF_STAGE` は変えないので件数帯は判断待ちへ飛ぶ）と、次の一手（`fix-pr`）だけである。
AI は修正を push するか、直すものが無い理由を返信して応え、どちらでも時刻が逆転して人の番に戻る。
理由と退けた案は [ADR 0016](adr/0016-pr-feedback-ai-turn.md)。

`latestAiNoteAt` を足したときに PR の指紋の版（`FINGERPRINT_VERSION`）を上げ、開いている PR の控えを 1 度ずつ引き直させた。
足す前の控えは `latestAiNoteAt: null` で読む（マージ済みの PR は引き直さないが、この値を使わない）。
stderr は本文を載せず `(HTTP 404)` の数字だけを取り出して 404 判定に使う。

PR のイベントの一覧（`issues/{n}/events`）は、PR の状態を問わず `enrich` のたびに 1 回、同じく `--paginate` で全ページ引く。
そこから 2 つの時刻を取る（`draftTransitionsOf`）。

- Ready にした時刻（`readyAt`）は、最後の `ready_for_review`。作成時から Ready の PR はこのイベントを残さないので、
  Draft でない PR でイベントが無ければ PR の作成時刻（`created_at`）で補う。今 Draft で一度も Ready にしていなければ `null`。
  区間の並び（`timeline`）の「PR レビュー」はここから数えるので、Ready の PR とマージ済みの PR でこそ要る
- Draft に戻された時刻（`convertedToDraftAt`）は、最後の `convert_to_draft`。今 open かつ Draft のときだけ値を持ち、
  それ以外は `null` にする（`resolveHold` がその前提で読む）

PR 一覧の全件取得はページングで取りこぼすため使わず、カード単位で問い合わせる。
カードの `mr` が分かっていれば番号で、無ければ `branch` から解決して書き戻す（`ForgePoller.fetchFor`）。

詳細（コメント 2 種・イベント・コミット）まで引くと PR 1 枚で 4 回以上になり、1 分ごとのポーリングでも
GitHub の上限（5,000 回/時）の大半を使う。そこで引いた結果を控えとして残し、次の 2 つで問い合わせを省く。

- マージ済みの PR は二度と引かない（`isSettled`）。マージされずに閉じた PR は reopen がありうるので引き続ける
- `pulls/{n}` を 1 回引き、指紋（状態・Draft・`head.sha`・コメントの件数・`updated_at`。`fingerprintOf`）が
  前回と同じなら詳細を引かずに前回の結果を使う

控えは 2 か所に分けて置く（`src/board/repositories/file-mr-snapshot.repository.ts`）。

- マージ済みの PR は、データ用ブランチの `snapshots/<id>.json` に `transact` を通して書く。二度と変わらないので、全員で 1 度引けば足り、クラウドの新しい clone でも引き直さずに済む
- それ以外は、git に載せない使い捨ての `<dataDir の親>/cache/mr-snapshots.json` に置く。クラウドでは毎回空から始まり、1 回目の `status` が引き直す

同じカードが両方にあれば、マージ済みの方を採る。控えはステージの導出の入力ではないので、データ用ブランチへ書けなくても
（オフライン、push の拒否、ロックの待ち切れ）警告するだけで、ポーラーを止めない。書けなかった控えは次のプロセスが引き直して書く。
控えはサーバと `ai-board status` のポーラーだけが書き、最初の `refresh` で読み戻す。
`status` は呼ばれるたびに新しいプロセスなので、控えが無いと毎回すべての PR を詳細まで引き直す。
`branch` から解決した PR 番号の書き戻しも、サーバと `status` では `transact` を通し（`createTransactionalMrWriter`）、取り直した後に番号が既に入っていれば何も書かない。
`MrState` に項目を足すと古い控えは検証で外れて引き直され、`enrich` の組み立てを変えたら `FINGERPRINT_VERSION` を上げる。

かつて GitLab の MR の番号も同じ `mr` 列に入っていた。GitLab の MR !1 と GitHub の PR #1 は別物で、
番号をそのまま引くと列は正しく埋まったままリンクだけが別の PR を指す。そのため出どころを確かめられない番号は
移行前の DB のマイグレーション（v2・v3）で消し、`branch` から解決し直させていた。


### `ai-board pr checks`（Ready の前の CI の確かめ）

締めの段のループが、PR を Ready にする前に CI を確かめるのに使う（`src/board/cli/pr-cli.ts`、判定は `src/board/services/pr-checks.ts` の純関数）。
ポーリングとボードの表示には使わない（ステージの導出にも使わない）。

- PR の `head.sha` から、`commits/{sha}/check-runs` を `--paginate --jq '.check_runs[]'` で、`commits/{sha}/status`（コンテキストごとの最新）を `--paginate --jq '.statuses[]'` で全件（1 件 1 行）引き、突き合わせずに 1 つの表にする
- `--sha <sha>` を付けると、そのコミットを見る。PR の head がまだそのコミットでなければ（push の直後）チェックを引かず、走っているとして扱う。締めの段は手元の `HEAD` を渡し、前のコミットの済んだ結果で通らないようにする
- 1 本ごとの結果: `check-runs` は `status` が `completed` でなければ走っている、`success` / `neutral` / `skipped` は通った、ほか（知らない値も）は落ちた。`status` は `pending` が走っている、`success` が通った、ほかは落ちた
- 全体の判定: 落ちたものがあれば `failed`、無くて走っているものがあれば `pending`、行が無ければ `none`、ほかは `passed`。終了コードは `passed` / `none` が 0、`failed` が 1、`pending` が 2、PR やチェックを読めなかったら 3（落ちたのと見分ける）
- `--wait` は CLI の中で 15 秒おきに引き直し、走っている間と、見るコミットのチェックがまだ無い間（そのコミットが PR の head になってから 120 秒まで）待つ。上限（`--timeout`、既定 900 秒）まで終わらなければ `pending` の 2 で終わる
- `status` が HTTP 403 / 404 のとき（クラウドのセッションの GitHub App は Commit Status API を読めない）は、`check-runs` だけで判定し、`statusUnreadable` に理由を出す。ほかの失敗は止める

## API

| メソッド | パス                     | 用途                                                    |
| -------- | ------------------------ | ------------------------------------------------------- |
| `GET`    | `/api/board`             | 全カード＋導出ステージ＋計画の進捗 / レビュー要求の情報 |
| `POST`   | `/api/cards`             | 新規アイデアカード作成                                  |
| `PATCH`  | `/api/cards/:id`         | frontmatter の部分更新                                  |
| `PUT`    | `/api/cards/:id/body`    | 本文の差し替え                                          |
| `POST`   | `/api/cards/:id/reviews` | `## レビュー` へのエントリ追記（承認 / 否決 / 中止）    |
| `POST`   | `/api/cards/:id/move`    | 直前・直後のカード（`after` / `before`）の間へ並べ替え  |
| `POST`   | `/api/idea-divider/move` | アイデアの表の区切り線を直前・直後のカードの間へ動かす  |
| `GET`    | `/api/events`            | SSE。ファイル変更・ポーリング結果を push                |

カードを返す口（`GET /api/board` の各カードと、`PUT /api/cards/:id/body` などの応答）は、本文と判断を分けて返す。
`body` は `## レビュー` の節を除いた本文（`stripReviewSection`）、`reviews` は判断を書かれた順（`log/` の順）に並べた `{ at, gate, kind, reason }` の配列である
（`toBoardCard` と `card.controller.ts` の `toCardResponse`）。`Card.body` は組み立てた本文のままで、読む側（ステージの導出・`get-board.query`・CLI）と `card show` の出力は変えていない。
`reviews` の理由は組み立てた本文から読むので、`#`〜`###` の行は `####` に下がった文になる（`log/` の元の文ではない）。
画面の詳細パネルは `body` を本文の欄に、`reviews` を「判断の記録」の欄（`ReviewLog.tsx`）に出す。
理由は `src/shared/markdown.ts` の `parseReasonBlocks`（`parseBlocks` の木の見出しを、記号付きの段落に置き換える）で整形するので、見出しの行は見出しにならない。

`GET /api/board` の各カードは `hold`（止まり。`{ reason, since }` か `null`）と、
`mrState.readyAt`（最後に Ready にした時刻）、`mrState.convertedToDraftAt`（最後に Draft へ戻された時刻）、
`timeline`（区間の並び。各区間に待ちと作業の `phases`）、`loopSteps`（そのカードのループの 1 手の記録）も持つ。
`ai-board status --json` の `cards[]` も同じものを持つ。
ボード全体には `loop`（`{ running, lastFinishedAt }`）が付く。`status --json` も同じ `loop` を持つ。

## 区間の並び（timeline）

`timeline` は、カードが各工程にいた時間を区間の配列として時刻の順に並べたもので、
`src/board/services/stage-timeline.ts` の純関数 `resolveTimeline` が痕跡から毎回導出する（保存しない）。
痕跡は `created`・`startedAt`・`## レビュー` の全エントリ・`readyAt`・`convertedToDraftAt`・`mergedAt` で、
`## レビュー` は `currentEntries` を通さずに全部読む（「計画から立て直させる」のような今は効いていない古いエントリこそが区間の境目になる）。
区間は `{ kind, owner, start, end }` で、種類（8 種類）と担当（`human` / `ai`）の一覧は `src/shared/timeline.ts` にある。
今いる区間は `end: null` で、導出は今の時刻を受け取らない（長さを出す側が `generatedAt` までを数える）。
マージと中止は今の区間を閉じるだけで次の区間を始めない。長さ 0 の区間は落とし、隣り合う同じ種類の区間はつなぐ。
画面にはまだ出さない。

**待ちと作業。** `GetBoardQuery` は `resolveTimeline` の結果を `src/board/services/timeline-phases.ts` の純関数 `splitAiPhases` に通し、
各区間に `phases`（`{ kind: 'wait' | 'work', start, end }` の配列、型は `src/shared/timeline.ts` の `PhasedTimelineSegment`）を付ける。
AI の区間では、そのカードのループの 1 手の記録を区間の範囲で切り取り、重なった部分を `work`、区間の中のそれ以外を `wait` にする。
重なる記録はつなぎ、終わっていない区間・記録は `end: null` のまま扱う（今の時刻は受け取らない）。
人の区間と、記録が 1 つも重ならない AI の区間は空にする（記録を始める前の区間を、全部「待ち」と言い張らないため）。
`resolveTimeline` は 1 手の記録を読まない。区間の導出（痕跡だけから決まる）と分け方を混ぜないためである。

## ループの 1 手の記録

ループ（`/board-loop` を動かした本筋のセッション）が 1 手を始めてから終えるまでを、1 件の記録としてデータ用ブランチの `loop/` に置く。
本筋のセッションが手の始まりに `start`、終わりに `finish` を書く。`agent` はレビューの段で立てた `board-reviewer` の名前で、自分で進めた手は `null`。
`durationMs` は `finish` に `--duration-ms` が無ければ開始から終了までのミリ秒で埋まる（0 未満は 0）。`tokens` は `board-reviewer` の結果に載っていたときだけ埋まる。
型と語は `src/shared/loop-step.ts`、ファイルの形と読み書きは `src/board/repositories/loop-history.repository.ts`、CLI は `src/board/cli/loop-cli.ts`。

- ファイル名は `loop/<開始の時刻>.<ループの識別子>.json`。時刻は判断のファイルと同じ `toLogStamp` の形で、同じ時刻と識別子が重なれば `-2` を付ける。
  識別子は `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`（ファイル名に入るため）
- 中身は `{ loop, cardId, action, step, agent, startedAt, finishedAt, result, tokens, durationMs }`。
  開始で `finishedAt` / `result` / `tokens` / `durationMs` を `null` にして作り、終了で 1 度だけ埋める。終わった記録は書き換えない
- `result` は `advanced` / `held` / `stopped`（手の終わりの `結果:` の語）、`failed`（`board-reviewer` の `Agent` の失敗）、`unknown`（結果の語が無い）、`interrupted`（途切れた）
- `ai-board loop start` は、同じループに終わっていない記録が残っていれば `interrupted` で閉じてから作る（閉じた時刻は新しい手の開始）。
  `finish` は、そのループの終わっていない記録を埋め、無いか `--card` が食い違えば拒む。`interrupted` は渡せない
- どちらも `DataStore.transact` の 1 操作で、コミットのメッセージは `loop: <start|finish> <cardId> <手>`。`DATA_PATHS` に `loop` を足してある
- `loop-cli.ts` は、カードについては「その ID のカードがあるか」を読む関数だけを受け取り、カードの書き込みの口を持たない
- 読めないファイル（JSON でない、項目が不正、ファイル名と中身の時刻や識別子が食い違う）は警告して読み飛ばす
- 手と段の値（`LOOP_ACTIONS` / `LOOP_IMPL_STEPS`）は `src/shared/` に置き、`NextActionKind` / `ImplStep` と食い違えば
  `loop-history.repository.ts` の `LOOP_VOCABULARY_IN_SYNC` で型エラーになる

形の版（`ai-board-data.yaml`）は上げない。`loop/` を足すだけで `cards/` と `order.yaml` の形は変わらず、
古い CLI は `DATA_PATHS` に `loop/` を持たないが、`git add` も `git clean -x` も `DATA_PATHS` の下だけを扱い、追跡済みの `loop/` のファイルは `reset --hard` で保たれる。

`GetBoardQuery` は全件を読み、`Board.loop`（`toBoardLoop`。ループごとの最新の終わっていない記録と、最後に終えた時刻）と、
カードごとの `loopSteps` と、区間の `phases` を組み立てる。ステージの導出・止まり・次の一手には渡さない。
トップバーと `status` の「ループ: …」の 1 行は `src/shared/loop-activity.ts` の `summarizeLoop` が `generatedAt` までを数えて作る（今の時刻は読まない）。
画面のカードの行の「AI 稼働中」はカードの `loopSteps` に終わっていない記録があるか（`hasRunningStep`）で、詳細パネルの「ループの手」の書式も同じファイルの純関数にある。
