# 研修の題材カードを main に置き、fork のボードへ `ai-board card seed` で取り込む

## 人に判断してほしいこと

- **題材の顔ぶれ。** 下の Decisions「題材の一覧」の 8 枚（研修の順路 7 枚＋予備のグリル 1 枚）でよいか。
  既定: この 8 枚で書く。差し替えたい題材・足したい観点があれば否決の理由に書く
- **`config.example.yaml` の例の値。** `github.repository` の例を `'iepyon/ai-board'` から置き換え前提の `'<owner>/<repo>'` に変えてよいか。
  このリポジトリの開発者も例を写して使うので、写した後に自分で書き換える手間が 1 つ増える。
  既定: 変える（fork した受講者が、元のリポジトリの PR を見に行く事故を防ぐ方を取る）

## 提案

### Why

研修では、受講者がペアやチームでこのリポジトリを 1 つ fork し、手元の PC で用意された題材のループを 2 日間回す。

カードの正本は `origin` の `ai-board/data` ブランチにある（ADR 0010）。GitHub の fork は既定で main しか写さないので、fork のボードは空になる。
すべてのブランチを写しても、写るのはこのリポジトリ自身のバックログで、研修の題材ではない。
題材を講師が毎回手で起票するのではなく、main に置いた一式からコマンド 1 つで取り込めるようにする。

あわせて、`config.example.yaml` の `github.repository` の例が `'iepyon/ai-board'` のままなので、
受講者がそのまま写すと自分の fork ではなく元のリポジトリの PR を見に行く。

### What Changes

受講者から見た変化は次のとおり。

- main に研修の題材が `training/cards/<id>.md` として 8 枚置かれる（研修の順路 7 枚＋予備 1 枚）
- `ai-board card seed --from training/cards` で、まだボードに無い題材だけがアイデアのカードとして起票される。
  何度走らせても重複しない。既にある ID は「飛ばしました」と出る
- 取り込んだカードは `rank`・`startedAt`・`## レビュー` を持たない。並び順と着手は人が決める
- 研修の資料 `training/README.md` に、fork から 1 周目を回すまでの手順、準備の確かめの項目（元 `setup-doctor`）、
  観点からハーネスの部品へたどる入口（元 `harness-guide`）、題材を回す順を書く
- `config.example.yaml` の例が `'<owner>/<repo>'` になる
- 取り込んだ後も main の `training/` は残す。題材はどれも `training/` を触らない

講師用の答え合わせ（各題材で否決したくなる点、捕まるはずのズレ）は、このリポジトリに置かない。

### Impact

- コード: `src/cards/cli/card-cli.ts`（`seed` のサブコマンド）、`src/cards/cli/seed-cards.ts`（新規。題材のファイルを読む純関数）、
  `src/cli-main.ts`（`seed` が使うディレクトリの読み取りを io に渡す）
- テスト: `src/cards/cli/__tests__/card-cli.test.ts`（`seed`）、`src/cards/cli/__tests__/seed-cards.test.ts`（新規。読み取りと、`training/cards` の題材がすべて読めること）
- 題材と資料: `training/cards/*.md`（8 枚）、`training/README.md`
- 設定の例: `.ai-board/config.example.yaml`
- ドキュメント: `README.md`（`card seed` と研修の資料への 1 行）、`CLAUDE.md`（CLI の一覧に `card seed`）
- ステージの導出・API・画面・データ用ブランチの形・人の判断の入口: 変わらない

## 設計

### Decisions

#### `ai-board card seed --from <dir>`

- `<dir>` の直下の `*.md` を、ファイル名の順に読む（下の階層は読まない）。`<dir>` は作業ディレクトリからの相対で解決する
- 1 ファイルが 1 枚。形は `ai-board card show` の出力と同じ frontmatter 付きの Markdown
  - 読むのは frontmatter の `id` と `title` と本文だけ。`id` は省けばファイル名から補い、書いてあればファイル名と一致しなければならない（`parseCard` と同じ決まり）
  - `rank`・`startedAt`・`skipGates`・`branch`・`mr`・`created` は書いてあっても読まない（起票の時刻は取り込んだ時刻）
- **先に全部読んでから書く。** 1 枚でも読めない（frontmatter が壊れている、`title` が無い、ID が不正、ファイル名と食い違う、同じ ID が 2 つある）なら、
  1 枚も起票せずに、読めないファイルと理由を全部出して 1 で終わる
- 起票は 1 枚ずつ `createCardCommand`（`card create` と同じ口）で、1 枚 1 コミットにする（コミットの文は `data: <id> を作る`）
  - `DuplicateCardId` は失敗にせず、`<id>: 既にあるので飛ばしました` と出す
  - 起票したら `<id>: 起票しました` と出す
  - それ以外の失敗（push の失敗、本文の `## レビュー` に判断がある、など）は理由を出し、そこで止めて 1 で終わる。それまでに起票した分は残る（次に走らせれば続きから起票される）
- 書き込みの境界は `createCardCommand` と `planCardWrite` がそのまま守る。新しいカードの本文の `## レビュー` に判断があれば `planCardWrite` が拒むので、
  題材のファイルに承認を書いても取り込まれない
- 使い方の文（`CARD_USAGE`）に `seed --from <dir>` を足す

ファイルの読み取りは `CardCliIo` に `readMarkdownDir(dir)` を足して渡す（`readStdin` と同じく、テストで差し替えられるようにする）。
ファイルの中身からカードの候補を作る処理は `seed-cards.ts` の純関数にし、`card-markdown.ts` の `parseCard` を使って frontmatter を読む。

#### 題材のファイル

frontmatter は `id`・`title` と、研修の資料と品質ゲートのための `touches`（その題材で変わる見込みのファイルの一覧）を持つ。
`touches` は `seed` が読まず、テストだけが読む。本文は `## アイデア` / `## 背景` と、必要なら `## 論点` を書く。答え合わせは書かない。

#### 題材の一覧

ai-board 自身への小さな改良で、1 枚を 1 周 30〜60 分で回せる大きさにする。どれも `training/` を触らない。研修の順路は上から。

| #    | ID                       | 観点                                              | 題                                                                               | 起きてほしいこと（講師の資料へ移す。この計画にだけ書く）                                                                      |
| ---- | ------------------------ | ------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 1    | `status-stage-counts`    | 品質ゲート（1 日目の 1 周目）                     | ユーザは、`ai-board status` の先頭で、列ごとのカードの枚数を見たい               | 小さく 1 周を体験する。ステージの名前を手で書くと、型とテストで捕まる                                                         |
| 2    | `card-list-idea-only`    | HIL・計画レビュー                                 | ユーザは、`ai-board card list` でアイデアのカードだけを絞り込みたい              | AI がカードにステージを保存する案を出しやすい。設計の不変条件（ステージを保存しない）に反するので計画レビューで否決したくなる |
| 3    | `card-id-too-long`       | 品質ゲート                                        | ユーザは、長すぎるカード ID を起票しようとしたとき、長すぎると分かる理由を見たい | エラー種を足すと `*-error-mappings.ts` の `switch` が網羅されず、型検査で捕まる                                               |
| 4    | `format-day-year`        | HIL・PR中                                         | ユーザは、カードの詳細の日付で、去年のカードと今年のカードを見分けたい           | テストは通るが、画面で動かすと表の列の幅が崩れる・今年の日付まで年が付いて読みにくい、などのズレが人の目で分かる              |
| 5    | `slug-fullwidth`         | 品質ゲート                                        | ユーザは、全角の英数字を含むタイトルから、`--id` を付けずにカードを起票したい    | `slugify` の境界（全角記号・空白・日本語だけのタイトル）でテストが AI の取りこぼしを捕まえる                                  |
| 6    | `status-waiting-url`     | HIL・PR中                                         | ユーザは、`ai-board status` の判断待ちの行から、PR をすぐに開きたい              | PR の URL を出すだけだが、動かすと行が長く折り返して読みにくい、PR の無いカードの扱いがずれる、などが人の目で分かる           |
| 7    | `decide-reason-required` | HIL・計画レビュー                                 | ユーザは、中止の理由を必ず残したい                                               | 「理由を必須にする」は画面と CLI の両方と、既存の理由の無い中止の扱いに及ぶ。範囲の決め方で計画レビューの判断が要る           |
| 予備 | `board-easier-to-read`   | グリル（`idea-grill` ができるまで順路に入れない） | ユーザは、ボードをもっと見やすくしたい                                           | わざと曖昧にしてある。何が見にくいのか・誰の何の作業か、を着手の前に問い詰めて詰める                                          |

1 日目に 1〜3 の 3 周、2 日目に 4〜7 の 4 周を目安にする。

#### 研修の資料 `training/README.md`

1. fork から 1 周目まで: fork → clone → `npm ci && npm run build` → `.ai-board/config.yaml` を写して `github.repository` を自分の fork に書き換える
   → `ai-board init` → `ai-board card seed --from training/cards` → 画面か `board-decide` で並べ替えと着手 → `board-loop`
2. 準備の確かめの項目（Claude に「準備を確かめて」と頼むときに見てもらう一覧）:
   `gh auth status`、`config.yaml` の `github.repository` が自分の fork を指す、データ用ブランチがある、auto モードで動く、ワークスペースを信頼済み、
   許可ルールの警告が出ない（`setup-doctor` の探索メモの候補）
3. 観点からハーネスの部品へ: HIL（計画レビュー・PR中、`board-decide`、ADR 0007）、文脈の切り分け（`board-reviewer`、ADR 0011）、
   品質ゲート（`CLAUDE.md` の品質ゲート、CI）、書き込みの境界（`ai-board card`、`.claude/settings.json` の deny、ADR 0012）。各項目は部品の場所への入口だけを書き、説明は Claude に聞く形にする
4. 題材を回す順（上の表の順。予備のグリルは `idea-grill` ができてから）
5. `training/` は取り込んだ後も消さないこと

#### 品質ゲートで題材の古びに気付く

`seed-cards.test.ts` で、リポジトリの `training/cards/*.md` をすべて読み、次を確かめる。

- `seed` の読み取りで読める（ID・`title`・ファイル名の一致）
- 本文の `## レビュー` に判断が無い
- `touches` のファイルがリポジトリにある（ai-board 自身の変更で題材の前提のファイルが消えたら、品質ゲートで気付ける）
- `touches` に `training/` の下のファイルが無い

### 仮定

- **`seed` は `ai-board card` に置き、`decide` には置かない。** 題材の起票はアイデアのカードを作るだけで、人の判断ではない。`card create` と同じ書き込み境界で足りる（カードの探索メモ 2026-11-05「取り込みの口」）
- **1 枚 1 コミットにする。** 今の `transact` は 1 回の操作で 1 枚のカードを返す形で、まとめて 1 コミットにするには `transact` の形を変える必要がある。
  題材は 8 枚なのでコミットが 8 つ増えても困らない。途中で止まっても、次に走らせれば続きから起票される
- **`created` は取り込んだ時刻にする。** 題材のファイルの時刻を使うと、ボードのタイムライン（ADR 0008）で研修より前にできたカードに見える
- **`<dir>` は作業ディレクトリからの相対にする。** `--root` からの相対にすると、ワークツリーで `--root` に main を渡したときに main の `training/` を読み、目の前のファイルと食い違う
- **`'<owner>/<repo>'` は今の検査（`owner/repo` の形）を通る。** 書き換え忘れると GitHub の問い合わせが失敗し、`status` の GitHub の行にエラーとして出る。黙って元のリポジトリを見るより気付きやすい
- **題材の `touches` は見込みでよい。** 受講者の実装が別のファイルを触っても構わない。テストが見るのは「題材の前提のファイルが今もあるか」だけである

### 退けた代案

- **題材の数だけ `card create` を呼ぶスクリプト:** 人と決めた（2026-11-05）とおり CLI に足す。スクリプトでは重複の扱いと全部読んでから書く検査をテストで守れない
- **データ用ブランチに題材を置く:** fork で写らない
- **全部を 1 コミットで起票する:** `transact` の形を変える必要があり、得るものがコミットの数だけである
- **読めないファイルを飛ばして残りを起票する:** チームで 1 つの fork を共有するので、一部だけ起票されると誰が何を直すかが分かりにくい。先に全部読んで、1 枚でも読めなければ何も書かない
- **答え合わせを `training/` に置く:** 受講者に見える（人と決めた、2026-11-05）
- **このリポジトリの既存のアイデアを題材にする:** カードの決まり（研修のために新しく作る）

### Risks / Trade-offs

- 題材は ai-board 自身の変更で前提がずれる。`touches` のテストはファイルが消えたことにしか気付けず、中身の変化（関数の名前や形）には気付けない
- 題材の大きさ（30〜60 分）は見積もりで、実際に回してみるまで分からない
- 受講者が同じ fork で同じ題材を並行して回すと、ブランチ名（カード ID）がぶつかる。チームで 1 枚ずつ着手する前提を資料に書く

### Non-Goals

- 講師用の答え合わせを書く（このリポジトリの外。表の「起きてほしいこと」は計画にだけ残す）
- 準備を確かめるコマンドを作る（`setup-doctor` の探索メモのとおり、項目の一覧だけを資料に置く）
- `idea-grill` のスキルを作る
- このリポジトリの計画の archive を fork のために片付ける
- `ai-board init` と `seed` を 1 つのコマンドにまとめる

## 探索メモとの対応

| #   | 探索メモ（短い引用）                                                                            | 反映した先                                                                    | 反映しなかった理由                                                                                         |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | `setup-doctor`: コマンドは作らず、確かめる項目の一覧を研修の資料に置く                          | Decisions「研修の資料」の 2、Non-Goals                                        |                                                                                                            |
| 2   | `harness-guide`: 観点から部品へたどる入口だけを置く                                             | Decisions「研修の資料」の 3                                                   |                                                                                                            |
| 3   | 取り込みの口は `card seed`。既にある ID は飛ばし、`rank`・`startedAt`・`## レビュー` は書かない | Decisions「`ai-board card seed`」、仮定 1                                     |                                                                                                            |
| 4   | 答え合わせは、このリポジトリの外                                                                | What Changes、Non-Goals、退けた代案                                           |                                                                                                            |
| 5   | HIL の題材を、計画レビューと PR中 の確かめに読み替える                                          | Decisions「題材の一覧」の 2・4・6・7                                          |                                                                                                            |
| 6   | `setup-doctor` / `harness-guide` のカードは中止して、中身はこのカードで扱う                     | Decisions「研修の資料」                                                       | カードの扱いは人の判断で、計画では触らない（中止はアイデアの列では書けず、2 枚は一覧の一番下へ並べ替えた） |
| 7   | グリルの題材は `idea-grill` ができるまで予備                                                    | Decisions「題材の一覧」の予備、「研修の資料」の 4                             |                                                                                                            |
| 8   | 準備の確かめに `github.repository` が自分の fork を指すかを足す                                 | Decisions「研修の資料」の 1・2、`config.example.yaml`                         |                                                                                                            |
| 9   | 取り込んだ後も main の題材は消さない。題材は `training/` を触らない                             | What Changes、Decisions「品質ゲートで題材の古びに気付く」、「研修の資料」の 5 |                                                                                                            |

## 動作確認の手順

ワークツリーは `$MAIN/.claude/worktrees/training-seed`（以下 `$WT`）。共有のカードを汚さないよう、`rules.md` の「動かして確かめるとき」のとおり
スクラッチパッドの bare リポジトリを `origin` にした clone（`$S/data`）を `AI_BOARD_DATA` で指し、`init` で空のデータ用ブランチを作ってから動かす。

1. 題材が全部起票される
   - コマンド: `cd "$WT" && AI_BOARD_DATA="$S/data" node dist/cli.js card seed --from training/cards`
   - 期待: 8 行の `<id>: 起票しました` が出て 0 で終わる
2. 2 回目は何も起票しない
   - コマンド: 1 と同じコマンドをもう一度
   - 期待: 8 行の `<id>: 既にあるので飛ばしました` が出て 0 で終わり、`git -C "$S/data" log --oneline | wc -l` が増えない
3. 起票したカードがアイデアの列にあり、判断を持たない
   - コマンド: `cd "$WT" && AI_BOARD_DATA="$S/data" node dist/cli.js status --json --only ideas,cards.stage,cards.latestReview`
   - 期待: 8 枚がすべて `idea` で、`latestReview` が null
4. 読めないファイルがあれば 1 枚も起票しない
   - コマンド: スクラッチパッドに `title` の無いファイルを含むディレクトリを作り、新しい `$S/data` に対して `card seed --from <そのディレクトリ>`
   - 期待: 読めないファイルと理由が出て 1 で終わり、カードが増えない
5. 研修の資料の手順で fork から 1 周目まで進める（AI は動かせない。走らせていない）
   - 人が実際に fork し、`training/README.md` の手順どおりに `init` と `seed` を走らせて、ボードに 8 枚が並ぶことを見る

## タスク

### 1. `card seed`

- [ ] `src/cards/cli/seed-cards.ts` に、ディレクトリの中身（ファイル名と中身の組）からカードの候補を作る純関数を足す（`parseCard` を使う。読めないファイルと同じ ID の重複を理由付きで返す）
- [ ] `CardCliIo` に `readMarkdownDir` を足し、`src/cli-main.ts` で `node:fs` を使って渡す
- [ ] `card-cli.ts` に `seed --from <dir>` を足す（全部読んでから 1 枚ずつ `createCardCommand`、`DuplicateCardId` は飛ばす）。`CARD_USAGE` に足す
- [ ] `seed-cards.test.ts` と `card-cli.test.ts` に、読み取りの各場合（`id` の省略・食い違い・`title` 無し・重複・余分な frontmatter を読まない）と、
      起票・飛ばし・途中の失敗・`## レビュー` に判断のある本文を拒むことのテストを足す
- [ ] 品質ゲートを通す

### 2. 題材と資料

- [ ] `training/cards/` に題材 8 枚を書く（frontmatter に `id`・`title`・`touches`）
- [ ] `seed-cards.test.ts` に、`training/cards` の題材がすべて読め、`## レビュー` に判断が無く、`touches` のファイルがあり、`training/` を含まないことのテストを足す
- [ ] `training/README.md` を書く（Decisions「研修の資料」の 1〜5）
- [ ] `.ai-board/config.example.yaml` の例を `'<owner>/<repo>'` にし、書き換える旨のコメントを足す
- [ ] `README.md` と `CLAUDE.md` の CLI の一覧に `card seed` を足し、`README.md` から `training/README.md` へ 1 行で案内する
- [ ] 品質ゲートを通す
