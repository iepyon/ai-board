# カードを git のデータ用ブランチに移し、クラウドのセッションだけでボードを回す

## この計画で使う言葉

- **データ用ブランチ**：カードの正本を置く orphan のブランチ `ai-board/data`。コードの履歴とは交わらない。
- **データのワークツリー**：データ用ブランチを手元に展開した場所。`ai-board` の CLI とサーバだけが書く。
- **書き込みの 1 操作**：CLI やサーバがカードに書くときの単位。「ロックを取る → 取り直す → 検査する → コミットする → push する」をまとめて行う。
- **取り直し**：データのワークツリーを `origin/ai-board/data` に合わせ直すこと（`git fetch` と `git reset --hard`）。手元にしか無い変更は持たない前提なので、捨ててよい。
- **クラウドのセッション**：Claude Code のアプリから立ち上げる、毎回新しい clone から始まるセッション。常駐のサーバは無い。
- **監視役 / サブエージェント**：`subagent-rules.md` の「呼び名」のとおり。

## 提案

### Why

外出中に、スマホの Claude Code アプリからボードを進めたい。
手元の Mac を動かし続ける前提にはしない。
クラウドのセッションを立ち上げて、人の判断と AI の作業をその中で回したい。

今のカードは `.ai-board/board.db` にあり、git に載らない。
クラウドのセッションは毎回新しい clone から始まり、push したもの以外は残らないので、カードが見えない。

置き場所には GitHub Issues も検討したが、git のデータ用ブランチを選ぶ（カードの `## 背景` のとおり）。
clone した時点でカードが揃い、読むのに API を使わない。
push の拒否をそのまま楽観ロックに使える。
判断ごとにコミットが残るので、人の判断の痕跡も今より辿りやすくなる。

### What Changes

使う人から見た変化は次のとおり。

- カードは `origin` の `ai-board/data` ブランチにある。手元のボード（`ai-board`）も、クラウドのセッションも、同じカードを見る
- 手元では `ai-board` を起動すると、メインのチェックアウトの下の `.ai-board/data/` にデータのワークツリーが作られる。画面の操作はそのまま使え、押すたびにコミットと push が走る
- クラウドのセッションでは、`ai-board status --html` が作るボードの HTML を、会話のセッションが Artifact として公開して見る。判断は会話で頼む（`board-decide`）
- エージェントの手順書の `gh pr create / view / edit / ready / comment / diff` は `ai-board pr ...` に置き換わる。手元でもクラウドでも同じ手順書で動く
- 切り替えの日に、人が 1 回だけ `ai-board migrate` を走らせ、`board.db` の中身をデータ用ブランチへ書き出す

中の仕組みの変化は次のとおり。

- カードのリポジトリ（`CardRepository` / `IdeaDividerRepository`）の実装を、SQLite からデータのワークツリーのファイルへ差し替える。インターフェースと usecase、`stage-resolver.ts`、`review-log.ts` の入力は変えない
- 書き込みの usecase を、書き込みの 1 操作（`DataStore.transact`）の中で走らせる。push が拒否されたら rebase せず、取り直して usecase を頭からやり直す
- GitHub の接続の確かめ方を `gh auth status` から `gh api` の REST に変える（クラウドでは `gh auth status` が失敗するため）
- `node:sqlite` は `ai-board migrate` で古い DB を読むためだけに残す

### Impact

- データの層（新規）: `src/infrastructure/data-store.ts`（ロック・取り直し・コミット・push）、`src/cards/repositories/file-card.repository.ts`、`file-idea-divider.repository.ts`、`card-files.ts`（ファイルの形）
- 差し替え・削除: `sqlite-card.repository.ts`、`sqlite-idea-divider.repository.ts`、`src/board/repositories/sqlite-mr-snapshot.repository.ts`、`src/infrastructure/database.ts`（`watchDatabase` は無くなり、`migrate` の読み出しだけが残る）
- 組み立て: `src/cards/composition.ts`、`src/board/composition.ts`、`src/server.ts`、`src/cli-main.ts`、`src/app.ts`、`src/infrastructure/watch.ts`
- 設定と場所: `src/shared/config.ts`（`dbPath` → `dataDir`、`AI_BOARD_DB` → `AI_BOARD_DATA`、`config.yaml` の場所）、`src/shared/git-worktree.ts`、`src/infrastructure/server-info.ts`
- GitHub: `src/board/services/github-client.ts`（`checkAuth`、PR の書き込み）、`src/infrastructure/forge-poller.ts`、新規の `src/board/cli/pr-cli.ts`
- CLI: `src/cards/cli/card-cli.ts`（`import` を `migrate` に置き換える）、`src/board/cli/status-cli.ts`（`--html`）
- エラー: `src/cards/errors/card-errors.ts` と `src/cards/controllers/card-error-mappings.ts`（push の失敗を足す）
- ループ: `.claude/agents/board-*.md`、`.claude/skills/board-loop/`、`.claude/skills/board-decide/SKILL.md`
- 設定（新規）: `.claude/settings.json`（deny ルール）、`.gitignore`
- ドキュメント: `CLAUDE.md`（`board.db` の節、書き込み境界、ワークツリーの共有）、`README.md`、`docs/architecture.md`、`docs/specs/` の該当箇所
- テスト: SQLite のリポジトリのテストを、一時ディレクトリの bare リポジトリを `origin` にしたファイルのリポジトリのテストに置き換える。`board.e2e.test.ts` も同じ置き場所で動かす
- API: 形は変えない。書き込みの応答は push を待つ分だけ遅くなり、push に失敗すると 503 を返す

## 設計

### Decisions

#### データ用ブランチの形

```
（例）ai-board/data ブランチの中身
ai-board-data.yaml          形の版（version: 1）。CLI はこれより新しい版を読まずに止まる
config.yaml                 GitHub の接続設定（今の .ai-board/config.yaml と同じ形）
order.yaml                  rank とアイデアの区切り線
cards/<id>/card.md          frontmatter（id, title, created, skipGates, branch, mr）と本文
cards/<id>/log/<時刻>.<gate>.<種別>.md   判断 1 件。中身は理由の本文
snapshots/<id>.json         マージ済みの PR の控え
```

- `card.md` の形は `ai-board card show` の Markdown にそろえるが、`startedAt` と `rank` と `## レビュー` は持たない。この 3 つは、それぞれ `log/` と `order.yaml` から組み立てる
- `skipGates` は `card.md` の frontmatter に置く。人の判断だが、書けるのは人の API だけで（CLI に入口は無い）、ファイルを直接書く道は deny ルールで止める。履歴はコミットに残る
- `card.md` の本文に `## レビュー` の節があっても読まない。リポジトリは `log/` から組み立てた `## レビュー` を、本文の末尾に付けて `Card.body` にする。`card show` でも、`## レビュー` は常に最後の節になる
- 理由の中の `#` で始まる見出しの行は、組み立てるときに `####` へ下げる。下げないと、理由の中の `## ` で `## レビュー` の節が途中で切れる。
  今も 3 枚のカード（`stage-timeline` / `chat-decide` / `skip-plan-needs-start`）で、`verify 提出` の本文の `## 動かす手順` などが節を切り、後ろの見出しが本文の節として読まれている。判断のファイルには元の文のまま残す
- 判断のファイル名は `<時刻>.<gate>.<種別>.md`。時刻はコロンを含まない `20261101T035208.000Z` の形（ミリ秒まで）、`gate` は `plan` / `verify` / `start`、種別は英字の `submit` / `resubmit` / `hold` / `approve` / `reject` / `abort` / `start` / `unstart`。
  日本語のファイル名は `git` の出力で引用符付きにエスケープされ、人が読みにくいので避ける
- 同じミリ秒に同じ `gate` と種別が重なったら、`-2`、`-3` を後ろに付ける。読むときはファイル名の順に並べる。`gateState` は時刻の順で、同じ時刻なら後ろのものを採るので、並びが決まれば結果も決まる
- `startedAt` は `log/` の `start` の最新が `start`（着手）ならその時刻、`unstart`（着手を戻す）なら `null`。`start` のファイルは `## レビュー` には出さない（`REVIEW_KINDS` を増やさず、`review-log.ts` の入力を変えない）
- `order.yaml` は `{ divider: <数>|null, ranks: { <id>: <数> } }`。rank の無いカードは書かない
- 判断のファイルは追記だけで、書き換えも削除もしない。リポジトリは、保存しようとする `Card.body` の `## レビュー` が既存のエントリを変えていたら書かずに失敗する（今の `card body` の拒否と同じ考え）

#### 書き込みの 1 操作

`DataStore.transact(op)` が、次の順で行う。`op` は「今のカードを読んで、検査して、書く」関数で、usecase と CLI の検査（`submitRefusal`・`gateRejected`・`card body` の拒否）をまるごと含む。

1. ロックを取る（`<dataDir の親>/data.lock` を排他作成。中に pid と時刻。持ち主の pid が死んでいれば取り直す。5 秒待って取れなければ失敗）
2. 取り直す（`git fetch origin +refs/heads/ai-board/data:refs/remotes/origin/ai-board/data` → `git reset --hard origin/ai-board/data`）。
   refspec を明示するのは、単一ブランチや浅い clone（クラウドの clone がそうでありうる）では、ブランチ名だけの fetch が `FETCH_HEAD` しか更新せず、追跡のブランチが古いまま残るからである
3. `op` を走らせる。何も書かなければ（検査で拒んだ、変化が無い）コミットせずに終わる
4. `git add -A` → `git commit`（メッセージは `data: <id> に plan 提出 を足す` のように操作から作る）
5. `git push origin HEAD:ai-board/data`。拒否されたら 2 に戻る（3 回まで）。rebase はしない
6. ロックを放す

rebase しないのは、離れた行の編集を git が黙って混ぜ（`order.yaml` で確かめた）、検査を経ないままの状態が push されうるからである。
やり直しは `op` を頭から走らせるので、検査は必ず最新の状態に対して行われる。

git はすべて `cli-runner.ts` を通し、引数は配列で渡す（カード ID や理由をコマンド文字列に入れない）。
コミットに理由の文字列は入れず、ID・ゲート・種別だけを入れる。

読み出しは、CLI のコマンドの頭で 1 回取り直す（ロックを取って fetch と reset）。
`fetch` が失敗したら（オフライン）警告を出して手元の内容で読む。書き込みは push できないので失敗にする。
`origin` の無いデータのワークツリー（テスト用）では、fetch と push を飛ばしてコミットだけする。

#### 手元のデータのワークツリーの置き場所

メインのチェックアウトの `.ai-board/data/` に、`git worktree add` でデータ用ブランチのワークツリーを 1 か所置く。
`config.ts` の `sharedBoardDir` は今もリンクされたワークツリーからメインの `.ai-board/` を求めているので、`dataDir = <sharedBoardDir>/data` とすれば、どのワークツリーから動かしても同じ場所に解決される。
`git-worktree.ts` の解決は変えない。

データのワークツリーが無ければ、CLI とサーバが最初に作る（上と同じ refspec で fetch → `git worktree add .ai-board/data ai-board/data`）。
データ用ブランチが `origin` に無く、`.ai-board/board.db` があれば、「`ai-board migrate` を走らせてください」と言って止まる。どちらも無ければ空のデータ用ブランチを作るよう `ai-board migrate --empty` を案内する。

`AI_BOARD_DB` は `AI_BOARD_DATA` に置き換える。データのワークツリーの代わりに使うディレクトリ（git のリポジトリ）を指す。
ワークツリーでスキーマを変えるコードを試すときや、動作確認で共有のカードを汚さないときに使う。
そのディレクトリの `origin` に push するので、試すときはスクラッチパッドの bare リポジトリを `origin` にした clone を指す。

`server.json`・ロック（`data.lock`）・PR の控え（`cache/`）は、どれも `dataDir` の親に置く（既定なら `.ai-board/` の下、`AI_BOARD_DATA` ならそのディレクトリの隣）。
試しのデータが、本物のデータとロックや控えを共有しないようにするためである。`server.json` は `dbPath` の代わりに `dataDir` で照らし合わせる。

#### サーバ

- 画面の書き込み（判断・着手・並べ替え・飛ばす宣言・本文）は、CLI と同じ `transact` を通す。押してから push が終わるまで応答を待つ
- push に失敗したら（ネットワーク、3 回拒否）、新しいエラー種 `DataStorePushFailed` を 503 にする（`card-error-mappings.ts` を網羅する）
- 変更の検知は、`watchDatabase` をやめて chokidar でデータのワークツリー（`.git` を除く）を見る
- クラウドのセッションなどほかの場所からの書き込みは、ポーリングと同じ間隔（既定 60 秒）で取り直して拾う。手元にしか無い変更は無いので、取り直しで失うものは無い
- ポーラーの PR 番号の書き戻し（`saveMr`）も `transact` を通す。番号が既に入っていれば何も書かない

#### PR の状態の控え

- マージ済みの PR の控えは `snapshots/<id>.json` に置く（二度と変わらないので、全員で 1 度引けば足りる）。書くのはポーラーで、`transact` を通す
- 開いている PR の控えは、git に載せない使い捨ての `<dataDir の親>/cache/mr-snapshots.json` に置く。クラウドでは毎回空から始まり、1 回目の `status` が引き直す
- 指紋で詳細を省くしくみ（`fingerprintOf`）はそのまま使う。ETag と 304 は使わない（Non-Goals）

#### GitHub の接続の確かめ方

`checkAuth` を `gh auth status` から `gh api repos/<owner>/<repo>`（REST）に変える。
クラウドでは `gh auth status` が「GH_TOKEN が無効」と失敗するが、`gh api` は動く。
今のままだと `forge.status` が `connected` にならず、`status` の `next` が `null` になってループが回らない。

`config.yaml` はデータ用ブランチの根に置く。クラウドの clone には git に載らない各自のファイルが無いからである。
データ用ブランチに無ければ、今の `.ai-board/config.yaml` を読む（切り替えの前後で手元が止まらないように）。

#### `ai-board pr`

手順書の `gh pr` を置き換える。クラウドでは GraphQL が 403 で、`gh pr` が動かないため。

| コマンド                                                            | 中身（REST）                                             |
| ------------------------------------------------------------------- | -------------------------------------------------------- |
| `ai-board pr create --draft --head <b> --title <t> --body-file <f>` | `POST pulls`（`draft: true`）。番号と URL を出す         |
| `ai-board pr view <n> [--comments] [--body]`                        | `GET pulls/<n>` と、コメント 2 種                        |
| `ai-board pr edit <n> --body-file <f>`                              | `PATCH pulls/<n>`                                        |
| `ai-board pr comment <n> --body-file <f>`                           | `POST issues/<n>/comments`                               |
| `ai-board pr diff <n>`                                              | `GET pulls/<n>`（`Accept: application/vnd.github.diff`） |
| `ai-board pr ready <n>`                                             | 下を参照                                                 |

Ready にする経路だけは手元とクラウドで違う。
REST の `PATCH draft=false` では Draft が外れない。
クラウドでは `POST pulls/<n>/ccr/ready_for_review` で外れるが、手元では使えない見込みである。
そこで、まず `gh pr ready <n>`（GraphQL）を試し、失敗したら `ccr/ready_for_review` を試す。どちらも失敗したら両方の理由を出して失敗する。
手順書に Draft へ戻す操作は無いので、`convert_to_draft` の入口は作らない。

`gh` の呼び出しは今の `GhForgeClient` と同じく `cli-runner.ts` を通し、`--input` にファイルを渡して本文を引数に載せない。
`ai-board pr` はカードに書かないので、書き込み境界は変わらない。

#### ボードの Artifact

`ai-board status --html` が、ボードを 1 枚の自己完結の HTML として標準出力に出す。
区画への振り分けと並び（判断待ち / AI 作業中 / アイデア / マージ済み / 中止）は、画面と同じ `dashboard-sections.ts` の純関数を使う。
判断待ちのカードには提出の本文と PR の URL、止まっているカードには `hold.reason` を出す。ボタンは置かない（判断は会話で頼む）。

会話のセッションはこれをスクラッチパッドに書き、Artifact として公開する。同じパスで公開し直せば同じ URL で更新される。
Artifact の型（Dashboard など）は使わない。型はアカウントごとに違い、手元のテストで形を確かめられないからである。
手順は `board-loop` のスキルに「ボードを見せて」の節として足す。

#### 人の判断をクラウドでどう書くか

`board-decide` は人の API（サーバ）で書く。クラウドには常駐のサーバが無い。
CLI に人の判断の入口を足すと、`CLAUDE.md` の「CLI に入口を足すときはこの境界を崩さない」に反する。

そこで `board-decide` は、`status --json` の `server` が `null` のとき、そのセッションの中で `ai-board --no-open` をバックグラウンドで起動し、`server.json` から URL を読んで人の API を叩き、終わったら止める。
サーバは `127.0.0.1` にだけ bind するので、セッションの外からは叩けない。CLI の境界も API の形も変わらない。
手元で `server` が `null` のときに起動を頼んで止まる今の振る舞いは、クラウドかどうかで分けず、起動して使う形にそろえる。

この決め方は人の判断を仰ぐ（「判断してほしい点」の 2 つ目）。

#### 書き込み境界

- データのワークツリーに書くのは `ai-board` の CLI とサーバだけである。`.claude/settings.json`（新規）の deny ルールで、`.ai-board/data/**` への Edit / Write と、データ用ブランチへの直接の push（`Bash(git push * ai-board/data*)` など）を止める。この設定はクラウドのセッションでも効く
- 今も `sqlite3` で直接触らないことは手順書の決まりでしか守っていない。deny ルールは Bash の書き方を変えればすり抜けられるが、守りが今より弱まることは無い
- CLI の入口（`card` の 7 コマンド）と、それぞれの検査は変えない。`transact` の中で走るので、検査は取り直した最新の状態に対して行われる

#### 移行（`ai-board migrate`）

`board.db` を読み、データ用ブランチを作って push する。`ai-board import` の逆で、`import` は消す（Markdown のカードを持つ人はもういない）。

- `## レビュー` の各エントリを、元の `at` のまま `log/` の 1 件 1 ファイルに分ける。分けた後の本文には `## レビュー` を残さない
- `startedAt` が入っているカードは、その時刻の `start.start` を 1 件書く（着手を戻した履歴は DB に無いので作らない）
- `rank` と区切り線を `order.yaml` に、マージ済みの PR の控えを `snapshots/` に、`.ai-board/config.yaml` を `config.yaml` に書く
- 書き出した後、データ用ブランチから組み立て直した全カードが DB のカードと一致するかを確かめ、食い違えば push せずに止まる。
  比べるのは、frontmatter の項目（`startedAt` と `rank` を含む）、`parseReviewLog` のエントリ、`## レビュー` の節を除いた本文の 3 つである。
  `## レビュー` は最後の節へ動き、理由の中の見出しは下がるので、本文をそのまま比べると一致しない
- `origin` に `ai-board/data` が既にあれば、何もせずに止まる。`--empty` は DB を読まずに空のデータ用ブランチを作る

#### ルーティンの重複起動

`run_once_at` のルーティンが 3 回動いたことがある。同じ手が 2 つ同時に走っても、カードの書き込みは `transact` の push の拒否で 1 つにまとまる。
後から来た `submit` は取り直した状態で検査され、`plan` が既に提出済みなので拒まれる。
コードのブランチは、`board-planner` は「同じ名前のブランチが既にあれば止まる」、`board-task` は push の拒否で止まる。
2 つの clone から同じカードに `submit` を同時に書き、1 つだけが通ることをテストで確かめる。

#### `## 論点` のほかの項目

- **ブランチの後始末。** クラウドからはブランチを消せないので、リポジトリの「Automatically delete head branches」を有効にする。人がリポジトリの設定で行う（README に書く）
- **`assigned-issues` との関係。** 別のカードのまま残す。この計画では触らない
- **当初の動機（チームとの共有）。** データ用ブランチは GitHub の画面で読めるので、共有はある程度できる。Issues に置く案は取り下げる
- **ループをどこで回すか。** 人が開いた会話のセッションで `/loop` を回すのを主にする。ルーティン（最短 1 時間）は、止まっているものを動かす保険として README に手順だけ書く。通知はしない

### Risks / Trade-offs

- **このカード自身は今の流れで進む。** 手順書はメインのチェックアウトから読まれ、カードは `board.db` にある。このカードの実装中は、今の `gh pr` と `board.db` で進む。
  マージした後、メインの `dist` を作り直してから人が `ai-board migrate` を 1 回走らせるまで、ボードはカードを読めずに止まる（CLI は「migrate を走らせてください」と出す）。切り替えは人の作業で、手順を README に書く
- **書き込みが遅くなる。** 画面のボタン 1 回ごとに fetch と push が走るので、1〜2 秒かかる。オフラインでは書けない。手元だけで使う人には今より不便になる
- **push の失敗が画面の失敗になる。** 今の書き込みは手元の DB で必ず通る。これからはネットワークの都合で 503 が返りうる
- **ファイルを直接書き換える道が開く。** `b97280b` でファイルから SQLite へ移した狙い（書き込みを CLI に絞る）は、deny ルールで守る形に変わる。Bash の書き方次第ですり抜けられるのは今の `sqlite3` と同じである
- **REST で本文を更新すると「Generated by Claude Code」が末尾に付く。** 締めの段が本文を書き直すたびに付くかもしれない。クラウドで確かめ、重なるなら `ai-board pr edit` で既に付いている行を残して重ねない処理を足す
- **`ccr/` の経路はクラウドの内部の口である。** 名前や振る舞いが変わると Ready にできなくなる。`gh pr ready` を先に試すので、手元には響かない
- **段の数が多い。** データの層・`ai-board pr`・Artifact・ループの手順書・移行と、1 つの PR としては大きい。分け方は「判断してほしい点」の 1 つ目
- **SQLite をやめる案のほかに、SQLite のまま DB ファイルをデータ用ブランチに載せる案もある。** バイナリの差分は rebase も確かめもできず、判断の履歴もコミットに残らないので採らない

### Non-Goals

- GitHub Issues にカードを置くこと（取り下げる）
- ETag と 304 による問い合わせの節約。今の指紋で足り、`gh` が 304 で終了コード 1 を返す扱いを足すと複雑になる
- クラウドのセッションでボードの画面（React）を動かすこと。クラウドでは Artifact で読むだけにする
- ルーティンや通知の設定そのもの。README に手順を書くだけにする
- `assigned-issues`（Issue の取り込み）
- データ用ブランチを人が GitHub の画面から編集すること

## 動作確認の手順

共有のカードを汚さないよう、スクラッチパッドに bare リポジトリを作って `origin` にし、`AI_BOARD_DATA` でその clone を指して試す。
`board.db` の移行は、今の `board.db` を複製したものから行う。

1. 準備
   - `npm run build`
   - `S=<スクラッチパッド>`、`git init --bare $S/origin.git`、`git clone $S/origin.git $S/data`
   - `cp .ai-board/board.db $S/board.db`
2. 移行
   - `AI_BOARD_DATA=$S/data node dist/cli.js migrate --from $S/board.db` が通り、`git -C $S/origin.git log ai-board/data` に 1 コミットある
   - `$S/data/cards/<id>/log/` に、カードの `## レビュー` のエントリが 1 件 1 ファイルで並ぶ。ファイル名の時刻が元の時刻と同じ
   - `AI_BOARD_DATA=$S/data node dist/cli.js card list` と、今の `node dist/cli.js card list`（`board.db`）の出力が同じ
3. CLI と楽観ロック
   - `ai-board card create` で試しのカードを作り、`card branch` → `card submit` が、それぞれ 1 コミットとして `origin.git` に積まれる
   - 別に `git clone $S/origin.git $S/data2` を作り、2 つの端末から同じカードに `card submit` を同時に打つと、片方だけが通り、もう片方は「plan の提出は、plan が未提出か否決のときにしかできません」で失敗する
   - このリポジトリで開いた Claude Code のセッションに `.ai-board/data/order.yaml` の Edit を頼むと、deny ルールで拒まれる（拒まれるので共有のカードは変わらない）
4. サーバ
   - `AI_BOARD_DATA=$S/data node dist/cli.js --no-open` で起動し、ブラウザで今と同じボードが出る
   - 画面で着手・承認・並べ替えをすると、それぞれ `origin.git` にコミットが積まれる
   - `$S/data2` から `card submit` を打つと、60 秒以内に画面に反映される
5. ボードの Artifact
   - `AI_BOARD_DATA=$S/data node dist/cli.js status --html > $S/board.html` を開き、判断待ち / AI 作業中 / アイデア の区画と、提出の本文が出る
6. `ai-board pr`（この手順だけは本物の GitHub に触る）
   - このカードの PR 番号で `node dist/cli.js pr view <n> --comments` と `pr diff <n>` が読める。書き込み系（`create` / `edit` / `comment` / `ready`）は、人が試してよい PR を用意したときだけ試す
7. クラウド（マージ後に人が行う）
   - クラウドのセッションで `ai-board status` が `connected` になり、`next` が出る
   - `ai-board pr ready` が `ccr/ready_for_review` の経路で Draft を外す

## タスク

### 1. データの層

- [ ] `src/cards/repositories/card-files.ts` に、データ用ブランチのファイルの形を読み書きする純関数を書く
  - `card.md`（frontmatter と本文）・`log/` のファイル名（時刻・gate・種別、`-2` の連番）・`order.yaml`・`ai-board-data.yaml` の版
  - `log/` から `## レビュー` の節と `startedAt` を組み立てる関数と、`Card` の差分から足すファイルを求める関数（既存のエントリが変わる差分は拒む）
  - テスト: 往復で `Card` が変わらない / 同じミリ秒の連番 / 着手と着手を戻すの最新で `startedAt` が決まる / `## レビュー` の書き換えを拒む / 理由の中の `## ` の見出しで節が切れない / 新しい版を読まずに止まる
- [ ] `src/infrastructure/data-store.ts` に `DataStore` を書く。データのワークツリーの用意、ロック、取り直し、`transact`（コミットと push、拒否されたら 3 回まで頭からやり直す）
  - git は `cli-runner.ts` を通し、引数は配列で渡す。`origin` が無ければ fetch と push を飛ばす
  - テスト: 一時ディレクトリの bare リポジトリを `origin` にした 2 つの clone から同時に書き、拒否された側が取り直してやり直す / 検査で拒めばコミットしない / 生きていない pid のロックは取り直す
- [ ] `FileCardRepository` と `FileIdeaDividerRepository` を書き、`CardRepository` / `IdeaDividerRepository` を満たす。今の SQLite のリポジトリのテストをファイルのリポジトリに移す
- [ ] PR の状態の控えを、マージ済みは `snapshots/<id>.json`（`transact` を通す）、それ以外は `<dataDir の親>/cache/mr-snapshots.json` に置く `MrSnapshotRepository` の実装にする。`forge-poller.test.ts` を合わせる

### 2. 組み立てと設定

- [ ] `config.ts` に `dataDir` / `dataSource` と `AI_BOARD_DATA` を足す（`dbPath` / `dbSource` / `AI_BOARD_DB` は `migrate` が使うので、SQLite を消すタスクまで残す）。`config.yaml` をデータ用ブランチの根から読み、無ければ `.ai-board/config.yaml` を読む
- [ ] `server-info.ts` を `dataDir` で照らし合わせるように変える
- [ ] `card-cli.ts` の各コマンドと `status` を、頭で取り直してから読むようにし、書き込みのコマンドを `transact` の中で走らせる（`submitRefusal` などの検査も中に入れる）。データ用ブランチが無いときの案内を出す
  - テスト: `card-cli.test.ts` を一時の bare リポジトリで動かす。2 つの clone からの同時の `submit` で 1 つだけ通る（ルーティンの重複起動）
- [ ] サーバの書き込みを `transact` に通し、push の失敗を `DataStorePushFailed`（503）にする。`card-errors.ts` と `card-error-mappings.ts` を網羅する。`board.e2e.test.ts` を一時の bare リポジトリで動かす
- [ ] サーバの変更検知を、`watchDatabase` から chokidar のデータのワークツリーの監視と、ポーリングの間隔での取り直しに変える。ポーラーの `saveMr` を `transact` に通す
- [ ] `checkAuth` を `gh api repos/<owner>/<repo>` に変える。テストを合わせる
- [ ] `ai-board migrate [--from <db>] [--empty]` を足し、`ai-board import` を消す。`database.ts` を読み出しだけに縮め、SQLite のリポジトリと `config.ts` の `dbPath` / `dbSource` / `AI_BOARD_DB` を消す（`migrate` は `--from` の既定に `.ai-board/board.db` を使う）
  - テスト: `## レビュー` の時刻を保って分ける / `startedAt` から着手を 1 件書く / `## レビュー` の後ろに節があるカードも一致と判定する / 組み立て直したカードが DB と一致しなければ push しない / 既にデータ用ブランチがあれば止まる
- [ ] `.gitignore` に `.ai-board/data/`、`.ai-board/cache/`、`.ai-board/data.lock` を足す

### 3. `ai-board pr`

- [ ] `src/board/cli/pr-cli.ts` に `create` / `view` / `edit` / `comment` / `diff` / `ready` を書く。本文は `--input` のファイルで渡す。`ready` は `gh pr ready` を試し、失敗したら `ccr/ready_for_review` を試す
  - テスト: 偽の `CliRunner` で、各コマンドが組み立てる `gh api` の引数 / `ready` の 2 つの経路と、両方の失敗の理由
- [ ] `.claude/agents/board-planner.md`、`board-worker.md`、`board-reviewer.md`、`.claude/skills/board-loop/SKILL.md`、`README.md` の `gh pr ...` を `ai-board pr ...` に置き換える

### 4. ボードの Artifact と、クラウドでの判断

- [ ] `ai-board status --html` を足す。`dashboard-sections.ts` の振り分けで、判断待ち（提出の本文・PR の URL・止まりの理由）/ AI 作業中 / アイデア / マージ済み / 中止 を出す自己完結の HTML にする。HTML を組む関数は純関数にしてテストする
- [ ] `board-loop` のスキルに「ボードを見せて」の節を足す（`status --html` をスクラッチパッドに書き、Artifact として同じパスで公開し直す）
- [ ] `board-decide` のスキルを、`server` が `null` ならそのセッションで `ai-board --no-open` を起動し、`server.json` の URL で書いてから止める形に直す

### 5. 書き込み境界とドキュメント

- [ ] `.claude/settings.json` を作り、`.ai-board/data/**` への Edit / Write と、データ用ブランチへの直接の push を deny にする
- [ ] `subagent-rules.md` の `AI_BOARD_DB` を `AI_BOARD_DATA`（bare リポジトリを `origin` にした clone）に、`CLAUDE.md` の「タスクは board.db にある」・書き込み境界の表・ワークツリーの共有の注意を直す
- [ ] `README.md` に、切り替えの手順（マージ → `dist` を作り直す → `ai-board migrate`）、クラウドのセッションでの回し方（会話で `/loop`、ルーティンは保険）、リポジトリの「Automatically delete head branches」を有効にすることを書く
- [ ] `docs/architecture.md` の「カードの保存と通知」「GitHub の PR の取得」を、データ用ブランチと控えの置き場所、`checkAuth` に合わせて直す。`docs/specs/` で `board.db` や `AI_BOARD_DB` に触れている箇所を直す

### 6. 確かめる

- [ ] `npm run typecheck && npm run lint && npm run format:check && npm test` と `npm run build` を通し、`## 動作確認の手順` の 1〜6 をスクラッチパッドの bare リポジトリで試す
