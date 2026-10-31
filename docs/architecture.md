# 実装の細部

`CLAUDE.md` から移した、触る箇所に応じて読めばよい細部。
不変条件とハードルールは `CLAUDE.md`、使い方と 1 周の流れは `README.md` にある。

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
ゲートは計画を読む `plan` と、実装を動かして確かめる `verify` の 2 つ（`REVIEW_GATES`）。
廃止した `explore` のエントリは規定外として黙って無視される。

`gateState()` はゲートごとの最新エントリ 1 件で決まり、中止のエントリは判定から除く
（中止は工程の進捗と直交する終端の軸で、通過済みのゲートを巻き戻さない）。
状態は `none` / `submitted` / `held` / `approved` / `rejected` の 5 つで、`held` は最新が 保留 のとき。
どの規則も `held` でゲートを先へ進めないので、保留のカードは AI の列（計画提案中 / 実装中）に留まり、`hold` が立つ。
`gateState` は飛ばす宣言（`skipGates`）も approved で返すので、人の承認とは `skipGates` で見分ける。

後ろのゲート（`REVIEW_GATES` の並びで後ろ）は、前のゲートの最新の承認より古いエントリを数えない（`currentEntries`）。
計画を承認し直したなら、前の計画に対する動作確認の判断（否決・保留）はもう効かない、という意味である。
これが無いと、計画から立て直したカードで古い `verify 否決` が最新のまま残り、ループが `revise-impl` を選び続ける。
通常の流れでは verify のエントリはすべて plan の承認より後にあり、plan を飛ばすカードは承認のエントリを持たないので、どちらも何も外れない。
`latestGateEntry` も同じ規則でエントリを選び、全ゲートの状態は `gateStates()` でまとめて引く（`toFacts` と CLI の `planApproved` が使う）。

判断待ちの区画が出す提出の本文と待ち始めた時刻は、`latestReview` から取る。
`latestReview` は「その列が待っているゲート（`GATE_OF_STAGE`）の最新エントリ、無ければゲートを通じた最新」で、
どのゲートのものかを `gate` に持つ。

## 差し戻しと Draft の PR

否決の差し戻しに専用ルールは無い。ゲートが差し戻し中のときレビュー行と承認行が両方外れ、
1 つ手前の AI 列へ自然に落ちる。
verify も同じで、`verifying` のルールは「plan 承認済み かつ verify が submitted」の 1 本だけである。
否決・承認・飛ばす宣言のどれでも `verifying` が外れて 実装中 に落ちる。承認後に Ready にするのは AI の作業なので、
AI の列（実装中）で待つ。

「計画から立て直させる」は承認済みの計画への plan 否決で、専用の規則もエントリも無い。
plan が `rejected` になって 計画提案中 に落ち、ループは `revise-plan` を選ぶ。
計画を承認し直すと前の verify のエントリは数えられず（`currentEntries`）、ループは `implement` から始め直す。

計画ファイルはブランチにあり、ボードを動かすチェックアウトからは見えないことが多いので、
Draft の PR も計画レビューの列を立てる。Ready にした時点で PR中 へ進む。
動作確認を頼む時点の PR も Draft のままだが、Draft の PR が立てる計画レビューのルールは plan が未承認のときにしか
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
止まりは次の 4 つで、`reason` には人が何をすればよいかを書く（`HOLD_REASONS`）。

- 実装中で、人の最新の判断より後に PR が Draft に戻された（`mrState.convertedToDraftAt`）。
  verify の状態より先に見るので、`ready` と、動作確認を飛ばすカードの `implement` の両方が Ready にし直さない
- 実装中で、verify の最新が 保留（`board-worker` が `card hold --gate verify` を書いた）
- 計画提案中で、plan の最新が 保留
- 計画提案中で、plan が提出済みなのに計画ファイルも Draft の PR も見えない（作り直すと PR を二重に作りかねない）。
  PR の状態を引けていない（取得先に未接続、または起動直後で初回の取得前。`MrStateProvider.synced`）ときは、
  PR が無いのか分からないので立てない

人が承認 / 否決 / 中止を書けばそのエントリが最新になり、止まりは外れる。止まりを解く専用のエントリは無い。

## 判断のボタンと画面の区画

CLI（`src/cards/cli/card-cli.ts`）には `startedAt` / `rank` / `skipGates` を書く入口も、承認 / 否決 / 中止を追記する入口も無く、
`body` は `## レビュー` のエントリが変わる差し替えを拒む。
逆に人の API（`POST /api/cards/:id/reviews`）は `HUMAN_REVIEW_KINDS`（承認 / 否決 / 中止）だけを受け、提出 / 再提出 / 保留 は 400 で拒む。

どのカードにどの判断のボタンを出すかは `src/shared/dashboard-sections.ts` の `decisionsFor` が決める。

| カード                                        | ボタン                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| 計画レビュー                                  | 承認 / 否決して差し戻す / 中止                                         |
| 動作確認                                      | 承認 / 否決して差し戻す / 計画から立て直させる / 中止                  |
| 実装中で止まっている（verify 保留、Draft へ） | 実装を直させる（verify 否決）/ 計画から立て直させる（plan 否決）/ 中止 |
| 計画提案中で止まっている（plan 保留）         | 計画を直させる（plan 否決）/ 中止                                      |
| 計画提案中で止まっている（成果物が見えない）  | 中止                                                                   |

飛ばす宣言（`skipGates`）のあるゲートの承認 / 否決は出さない（否決を書いても差し戻しにならない）。中止は残す。
判断待ちのボタンを本文より前に出すか（`awaitsDecision`）は、`decisionsFor` が 1 つでも返すかで決まる。

UI が `startedAt` を書き換えるのは「着手」「着手を戻す」のボタンだけ。列をまたぐドラッグは無く、
ドラッグはアイデアの表の中の並べ替え（`rank`）と区切り線の移動にだけ使う。
`skipGates` を画面から書くのは、詳細パネルの「動作確認を飛ばす」のチェックボックス（`verify` の出し入れ）だけ。

画面の区画（判断待ち / AI 作業中 / アイデア / マージ済み / 中止）への振り分けと並び順も `dashboard-sections.ts` の純関数にある。
ステージの導出とは別物で、見せ方だけを決める。
`hold` のあるカードはステージが AI の列のままでも判断待ちの区画に入り、待ち始めた時刻（`waitingSince`）は `hold.since` になる。
「`startedAt` を外したときに残るステージ」（AI の成果物とレビュー記録が課す下限）より
前へは戻せない（`resolveFloorStage` / `droppableStages`）。

アイデアの表の区切り線は `rank` と同じ物差しの値を 1 つだけ持つ（DB の `idea_divider`）。
並べ替えの中ではカードと同じ 1 項目（`DIVIDER_ID`）として扱い、隙間が尽きた振り直しでも一緒に振り直す
（`src/cards/usecases/commands/move-in-order.ts`）。

## `ai-board status` と次の一手

`status` はサーバを起動せず、ボードと同じ組み立て（`createMrStateSource` → `getBoardQuery`）でステージを導出する。
PR の状態は `refresh()` を 1 回だけ待って引き、`branch` から解決した PR 番号の書き戻しもサーバと同じく起きる。

次の一手は `src/board/services/next-action.ts` の `pickNextAction`（実装中 → 計画提案中、列の中は `rank` の順）が決める。
手は `plan` / `revise-plan`（計画提案中）と `implement` / `revise-impl` / `ready`（実装中）の 5 種類で、
実装中の手は verify ゲートの状態で分ける（未提出 → `implement`、否決 → `revise-impl`、人の承認 → `ready`。飛ばす宣言なら `implement`）。
`implement` は計画のタスクの進み具合では分けず、AI レビューの手（`review`）も無い。
計画はブランチにあり、メインのチェックアウトからは読めないことが多いので、
`implement` を受けた `board-worker` がワークツリーの計画を読んで段（タスクを倒す / AI レビュー / 締め）を決める。
GitHub に接続できないとき（`forge.status` が `connected` でないとき）は `next` を `null` にする。

`status` の `waiting` は画面の判断待ちの区画（`groupBySection` の inbox）をそのまま使うので、止まっているカードも 1 度だけ出て、`working` には出ない。
止まっているカードの `reason` は `hold.reason` になる。
`waiting` の各カードは、画面がボタンとして出す判断（`decisionsFor`）を `decisions` に持つ。
`status --json` は、ほかにアイデアの表の並び（`ideas`。画面と同じ `ideaRows` の順で、区切り線も 1 行）と、
同じ DB を使って起動中のサーバの URL（`server`。無ければ `null`）を出す。どちらも `board-decide` のスキルが使う。

サーバは起動中の自分の場所（URL・pid・DB のパス）を DB の隣の `server.json` に書き、止まるときに消す
（`src/infrastructure/server-info.ts`。git には載せない）。`status` はこれを読み、DB が一致し pid が生きているときだけ `server` に URL を出す。

## カードの保存と通知

`card show` の出力（DB の列を frontmatter の形で表したもの）:

```yaml
---
id: board-search # 不変。生成後は変えない。ファイル名と一致する kebab-case
title: カードを絞り込めるようにする
created: '2026-09-04T06:48:23.416Z'
startedAt: null # 人が着手を指示した時刻（人が打つ）
skipGates: [] # 人が事前に見ないと宣言したゲート（plan / verify）
branch: null
mr: null # レビュー要求の番号（branch から自動解決して書き戻す）
rank: 1500 # 並び順（任意）。小さいほど上。人が並べ替えたときだけ書かれる
---
```

CLI の書き込みはサーバが `PRAGMA data_version` の変化で拾い、SSE 経由でブラウザへ即座に反映される
（`src/infrastructure/database.ts` の `watchDatabase`）。サーバ自身の書き込みは
`data_version` に現れないので、リポジトリの `onWrite` から通知する。

移行前の `.ai-board/cards/<id>.md` は `ai-board import` で取り込む。
Markdown 表現（`card-markdown.ts`）はこの取り込みと `card show` の出力にだけ使う。

## GitHub の PR の取得

`.ai-board/config.yaml` に `github:` を書いたときだけ有効で、無ければ `PR中` / `マージ済み` の列が空になるだけでボードは動く。
`gh` の有無とログイン状態は起動時に 1 度だけ確かめ（`ForgeClient.checkAuth`）、使えなければ理由付きで `disabled` にする。

GitHub の PR は `state` が `open` / `closed` の 2 値しかなく、**マージ済みも `closed`** で返る。
区別は `merged_at` の有無で付ける（`toLifecycleState`）。ここを取り違えるとカードが `merged` へ進まない。

レビューコメントは issue comment と review comment の 2 か所に分かれるため、合算して「人が書いた最新のコメント」とする。
どちらの一覧も既定は古い順の 1 ページ目だけで、`issues/{n}/comments` は `sort` /
`direction` を受け付けない（受けるのはリポジトリ単位の `issues/comments` の方）。
並び順に頼らず `gh api --paginate` で全ページ引いて最大値を取る。
最新コミットは `pulls/{n}/commits` ではなく `head.sha` を直接引く（件数で取り逃がさない）。
自動生成のコメントを示すフラグは無く、`user.type === 'Bot'` で外す。
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
GitHub の上限（5,000 回/時）の大半を使う。そこで引いた結果を DB の `mr_snapshots` に控えとして残し、次の 2 つで問い合わせを省く。

- マージ済みの PR は二度と引かない（`isSettled`）。マージされずに閉じた PR は reopen がありうるので引き続ける
- `pulls/{n}` を 1 回引き、指紋（状態・Draft・`head.sha`・コメントの件数・`updated_at`。`fingerprintOf`）が
  前回と同じなら詳細を引かずに前回の結果を使う

控えはサーバと `ai-board status` のポーラーだけが書き、最初の `refresh` で読み戻す。
`status` は呼ばれるたびに新しいプロセスなので、控えが無いと毎回すべての PR を詳細まで引き直す。
`MrState` に項目を足すと古い控えは検証で外れて引き直され、`enrich` の組み立てを変えたら `FINGERPRINT_VERSION` を上げる。

かつて GitLab の MR の番号も同じ `mr` 列に入っていた。GitLab の MR !1 と GitHub の PR #1 は別物で、
番号をそのまま引くと列は正しく埋まったままリンクだけが別の PR を指す。そのため出どころを確かめられない番号は
DB のマイグレーション（v2・v3）で消し、`branch` から解決し直させている。`ai-board import` も `forge: gitlab` の番号は捨てる。

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

`GET /api/board` の各カードは `hold`（止まり。`{ reason, since }` か `null`）と、
`mrState.readyAt`（最後に Ready にした時刻）、`mrState.convertedToDraftAt`（最後に Draft へ戻された時刻）、
`timeline`（区間の並び）も持つ。`ai-board status --json` の `cards[]` も同じものを持つ。

## 区間の並び（timeline）

`timeline` は、カードが各工程にいた時間を区間の配列として時刻の順に並べたもので、
`src/board/services/stage-timeline.ts` の純関数 `resolveTimeline` が痕跡から毎回導出する（保存しない）。
痕跡は `created`・`startedAt`・`## レビュー` の全エントリ・`readyAt`・`convertedToDraftAt`・`mergedAt` で、
`## レビュー` は `currentEntries` を通さずに全部読む（「計画から立て直させる」のような今は効いていない古いエントリこそが区間の境目になる）。
区間は `{ kind, owner, start, end }` で、種類（12 種類）と担当（`human` / `ai`）の一覧は `src/shared/timeline.ts` にある。
今いる区間は `end: null` で、導出は今の時刻を受け取らない（長さを出す側が `generatedAt` までを数える）。
マージと中止は今の区間を閉じるだけで次の区間を始めない。長さ 0 の区間は落とし、隣り合う同じ種類の区間はつなぐ。
画面にはまだ出さない。
