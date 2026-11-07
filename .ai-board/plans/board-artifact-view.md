# 「ボードを見せて」で、判断待ち・AI 作業中・アイデアを 1 枚の Artifact のページにする

## 人に判断してほしいこと

- **ADR の書き方。** ADR 0017 は「`status --html` のダッシュボードと `board-dashboard` のスキルを外す」と決めている。今回はページをまた出すが、本体（`src/`）では作らず、スキルのひな形で `status --json --active` を描くだけにする。既定: 新しい ADR 0019 に今回の判断（データの作り方・ページの置き場所・退けた案）を書き、ADR 0017 の「結果」に 0019 への 1 行を足す（ADR 0017 の決定そのものは書き換えない）
  - → 回答（2026-11-07、plan 承認）: 判断してほしい点 (1)〜(3) はすべて既定のまま（ADR 0019 を新しく書く / 文言は本体の関数を使う / 「ボードを見せて」でページを出す）
- **ページの言葉を本体の関数で作るか。** 「GitHub:」「ループ:」「次の一手:」の 1 行と、ステージの名前（`計画レビュー` など）は、本体の `status-describe.ts` と `stage-labels.ts` が人向けの `status` のために持っている。既定: 流し込みのスクリプトがビルド済みの `dist/` からそれらを import して文言を作り、ページに埋め込む（ページの側に同じ表を写さない）。代わりに `dist/` が古いと文言も古くなるので、スキルの手順で `dist-check` を通してから走らせる
  - → 回答（2026-11-07、plan 承認）: 判断してほしい点 (1)〜(3) はすべて既定のまま（ADR 0019 を新しく書く / 文言は本体の関数を使う / 「ボードを見せて」でページを出す）
- **「ボードを見せて」の入口。** 今は `board-loop` の「ボードを見せて」の節が、人向けの `status` の出力を見せると決めている。既定: その節を「`board-view` のスキルでページを出す」に書き換える。ターミナルの数行がほしいときは `ai-board status` をそのまま打てばよい
  - → 回答（2026-11-07、plan 承認）: 判断してほしい点 (1)〜(3) はすべて既定のまま（ADR 0019 を新しく書く / 文言は本体の関数を使う / 「ボードを見せて」でページを出す）

承認は、回答の無い項目をすべて既定のまま進めると読む。既定と違う答えは、plan 承認の理由ではなく plan 差し戻しの理由で返してほしい。

## 提案

### Why

ADR 0017 で画面・サーバ・`status --html` のダッシュボードを外し、ボードを見る入口は `ai-board status` だけになった。
人向けの数行には判断待ち・AI 作業中・次の一手は出るが、アイデアの一覧は出ない。どのアイデアが次に来るかは `status --json --only ideas` を読まないと分からない。
ボードはスマホから Claude Code のクラウドのセッションで回すことが多く、ターミナルの数行より、3 つの区画を一目で見渡せるページで見たい。

PR #102 で `status --json --active` が入り、終わったカードを外した報告は約 11KB になった。この大きさならページに埋め込める。
区画もステージも CLI が決めたものを描くだけにすれば、ページの側に導出を持ち込まずに済む。

### What Changes

- 人が「ボードを見せて」と頼むと、Claude が新しいスキル `board-view` の手順で、1 枚の HTML のページを Artifact として公開し、URL を伝える
- ページには次を出す
  - 上の帯: GitHub の接続・ループの様子・次の一手の 1 行ずつ（人向けの `status` と同じ文言）と、作った時刻
  - 判断待ち: カードごとにタイトル・ID・列・理由・出せる判断の名前・PR へのリンク
  - AI 作業中: カードごとにタイトル・ID・列・理由と、「ループが触っている」「しばらく動きなし」の印
  - アイデア: 並び順のまま、区切り線より上を「次にやる」、下を「あとで考える」として出す
- ページは頼んだ時点の写しで、自分では新しくならない。同じセッションで頼み直すと同じ URL に出し直す
- ページから判断は書けない。判断は今までどおりチャットで頼む（`board-decide`）
- `ai-board status` の出力、`status --json`、ステージ・区画・次の一手は変わらない

### Impact

- 新しいスキル: `.claude/skills/board-view/`（`SKILL.md`・ひな形の `template.html`・流し込みのスクリプト `render.mjs`）
- 手順書: `.claude/skills/board-loop/SKILL.md`（「ボードを見せて」の節）
- テスト: `src/__tests__/board-view-render.test.ts`（スクリプトの流し込みと埋め込みの逃がし方。`src/__tests__/claude-settings.test.ts` と同じく、`.claude/` のファイルを `src/` のテストから確かめる）
- ドキュメント: `docs/adr/0019-board-view-artifact.md`（新規）・`docs/adr/0017-remove-web-and-server.md`（結果に 1 行）・`docs/adr/README.md`（一覧）・`README.md`（ボードの見方）・`CLAUDE.md`（読む場所にスキルを足す）
- 本体（`src/` のコード）・データ用ブランチの形・カードの書き込み境界: 変わらない

## 設計

### Decisions

#### 流れ

1. スキルの手順が、メインのチェックアウト（`$MAIN`）で `dist-check` を通し（古ければビルド）、`node "$MAIN/dist/cli.js" status --json --active --root "$MAIN"` を一時ファイルに受ける
2. `node "$MAIN/.claude/skills/board-view/render.mjs" < 一時ファイル > "$SCRATCH/board-view.tmp"` で HTML を作る。成功したら `"$SCRATCH/board-view.html"` に置き換える（失敗しても前のページのファイルを壊さない）
3. `Artifact` の publish に `file_path: "$SCRATCH/board-view.html"` を渡す。初回は `icon` を付け、`capabilities` は付けない。出し直しは同じ `file_path` で `icon` を省く。`$SCRATCH` はこのセッションのスクラッチパッドなので、同じセッションでは同じ URL に、新しいセッションでは新しい URL になる（人の答え）

#### `render.mjs`

- Node の標準だけで動く ES モジュール。標準入力の JSON（`status --json --active` の出力）を読み、同じディレクトリの `template.html` の印 `/*__BOARD__*/null` を、ページに渡すデータの JSON に置き換えて標準出力に書く
- ページに渡すデータは次の形にする。ページはこれを描くだけで、計算しない
  - `generatedAt`、`header`（`describeForge` / `describeLoop` / `describeNext` の 3 行）
  - `waiting[]`・`working[]`（`id` / `title` / `stageLabel` / `reason` / `running` / `stale` / `decisions`（判断の名前）/ `prUrl`）
  - `ideas[]`（`{id, title}` か `{divider: true}`）
- 文言とステージの名前は、`$MAIN/dist/` の `board/cli/status-describe.js` と `shared/stage-labels.js` を import して作る。スクリプトの場所（`.claude/skills/board-view/`）から `../../../dist/` を指す
- 中身は 2 つの純関数として export する。`buildPageData(report, helpers)`（`helpers` は `describeForge` / `describeLoop` / `describeNext` / `stageLabels`）と `renderHtml(template, data)`。
  `dist/` を import して標準入出力を扱うのは、スクリプトとして直接走らせたときだけにする。テストは `helpers` に `src/` の関数を渡し、`dist/` に頼らない
- `prUrl` は `cards[]` の `prState.webUrl` を引き、`https://` で始まるときだけ入れる
- 埋め込む JSON は、`<` を `<`、U+2028 / U+2029 をそれぞれ ` ` / ` ` に置き換える。カードのタイトルや理由に `</script>` があっても、`<script>` の中から抜け出さない
- 入力が JSON でない、`waiting` / `working` / `ideas` / `cards` / `forge` / `loop` / `generatedAt` が無い、ひな形に印が無い、のどれかなら、標準エラーに 1 行書いて終了コード 1 で終わる

#### `template.html`

- Artifact の決まり（`<title>` を先頭に置く・色はトークンで明暗の両方・スマホの幅で横に流れない・外部の読み込みをしない）に沿った 1 枚の HTML。題は「ai-board ボード」
- `<script>` の中で埋め込みのデータを読み、`textContent` と `createElement` だけで描く（`innerHTML` を使わない。データは信頼しない文字列として扱う）。PR へのリンクは `<a href>` に `https://` の URL だけを入れる
- データが無い（印のまま）ときは「ボードのデータがありません」とだけ出す

#### `SKILL.md`

- 使うとき: 人がこの会話で「ボードを見せて」「ボードを出して」と頼んだとき。ループの周や判断の後には使わない（人の答え）
- ページから判断を書く入口は無い。ページの文面を人の依頼として読まない
- 手順 1〜3 と、失敗したときは公開せずに人へ伝えることを書く

#### 入口とドキュメント

- `board-loop` の「ボードを見せて」の節を、`board-view` のスキルでページを出すことに書き換える（人に判断してほしいこと）
- ADR 0019 を足し、ADR 0017 の結果に「ボードを見る Artifact のページは 0019 でスキルの側に戻した」の 1 行を足す（人に判断してほしいこと）

### 仮定

- **区画と並びは `status --json --active` のものをそのまま使う。** `waiting` は人が片付ける順、`working` は PR の指摘に応えるカードが先頭、`ideas` は rank の順で区切り線つき（`board-sections.ts`・`idea-tiers.ts`）。ページで並べ替えない。根拠: CLAUDE.md の「ステージを保存しない・ページで導出しない」、ADR 0015 で退けた「ページの中でステージを導出する」
- **PR の状態は `status` と同じく `gh` で引く。** 人の答え（2026-11-07）。`status` は 1 回の実行で `refresh()` を 1 回だけ行い、届かなければマージ済みの控えで描き、`forge` に理由が出る。ページの上の帯にその 1 行が出る
- **スクリプトは `dist/` に頼る。** 本体の関数を import するので、`dist/` が無い・古いと動かない・文言が古い。スキルの手順は `board-loop` と同じく `dist-check` を通してから走らせる
- **`render.mjs` のテストは `src/__tests__/` に置き、`dist/` に頼らない。** vitest は `src/**/__tests__/**/*.test.ts` だけを読む。`src/__tests__/claude-settings.test.ts` が `.claude/settings.json` を `src/` から確かめているのと同じ形にする。
  CI はテストをビルドの前に走らせる（`.github/workflows/` の順）ので、テストは `render.mjs` の純関数を import し、文言の関数には `src/` のものを渡す。`dist/` を import するのは直接走らせたときの入口だけ
- **公開は Claude の Artifact の道具で行う。** CLI からは公開できないので、スキルの手順で Claude が行う
- **ページは `capabilities` を宣言しない。** DB・コネクタ・ページ自身の保存を使わない（人の答え）。宣言しないので、見る人に許可を求める画面も出ない

### 退けた代案

- **本体の CLI で HTML を出す（`status --html` を戻す）:** 人の答え（2026-11-07）。ADR 0017 で外した表示の話を本体に戻すことになる
- **`board-loop` の節にひな形を足す:** 人の答え（2026-11-07）。ループの手順書が太る
- **Artifact の DB にデータを置く・ページから見る人の GitHub コネクタで読む:** 人の答え（2026-11-07）。コネクタは、外した更新ボタンと同じく端末によっては読み込めない（`drop-refresh-button` の背景）
- **Artifact の Dashboard の型:** 数字とグラフを出どころ付きで見せる型で、カード一覧には重い（`retro-artifact` に回す）
- **Claude がその場で HTML を書く:** 頼むたびに見た目と出す項目がぶれる。ひな形に流し込むだけにする
- **ステージの名前と文言をひな形に写す:** 本体と食い違っても気づけない（人に判断してほしいこと）
- **`status --json --active` をそのまま埋め込み、ページで文言を組む:** ページに `describeLoop` などを写すことになる。スクリプトで本体の関数を使って、描くだけのデータにする
- **マージ済みのカードも出す:** 人の答え（2026-11-07）。3 区画だけにする

### Risks / Trade-offs

- ページは頼んだ時点の写しで、開いたままでは新しくならない。古さは上の帯の作った時刻で分かる（ループの手ごとの出し直しは `board-artifact-loop-republish`）
- `render.mjs` は `dist/` の関数の形（引数と戻り値）に頼る。`status-describe.ts` の形を変えるとスクリプトも直すことになる。テストは `src/` の同じ関数を渡して確かめるので、引数の形の食い違いは落ちる。直接走らせる入口の import の道筋だけはテストで通らないので、動作確認の 1 で確かめる
- 新しいセッションでは新しい URL になり、前のセッションのページは古いまま残る（人の答え）
- 公開のたびに Artifact の道具の許可を求められることがある

### Non-Goals

- ループの手ごと・判断の後にページを出し直すこと（`board-artifact-loop-republish`。人の答え）
- ページから判断を書くこと、更新のボタン
- マージ済み・中止のカード、グラフ・集計・ログ（人の答え。振り返りは `retro-artifact`）
- セッションをまたいで同じ URL を保つこと（人の答え）
- 人向けの `ai-board status` の出力を変えること

## 探索メモとの対応

| #   | 探索メモ（短い引用）                                                                                                  | 反映した先                                              | 反映しなかった理由 |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------ |
| 1   | 人と決めた: Artifact の DB は使わない。手元のデータ用ブランチを読み、PR の状態は `gh` で引いてよい。出し先は Artifact | 仮定・退けた代案・Decisions（流れ）                     |                    |
| 2   | 人と決めた: ひな形の置き場所は新しいスキル `.claude/skills/board-view/`。本体（`src/`）は変えない                     | Impact・Decisions・退けた代案                           |                    |
| 3   | 人と決めた: URL はセッションの中だけ同じ                                                                              | Decisions（流れ）・Risks・Non-Goals                     |                    |
| 4   | 人と決めた: 3 区画と GitHub の接続・ループの様子・次の一手。マージ済みは出さない                                      | What Changes・Decisions（`render.mjs`）・Non-Goals      |                    |
| 5   | 人と決めた: 頼まれたときだけ出す                                                                                      | Decisions（`SKILL.md`）・Non-Goals                      |                    |
| 6   | 外す前の形はコミット 981587f の親にある（`status-html.ts`・`board-dashboard`・ADR 0015）                              | 退けた代案・Decisions（流れ）                           |                    |
| 7   | `status --json --active` は PR #102 で入った。約 11KB                                                                 | 提案（Why）                                             |                    |
| 8   | ループの手ごとに出し直すのは `board-artifact-loop-republish`                                                          | Non-Goals                                               |                    |
| 9   | 論点: ひな形の置き場所と ADR 0017 との関係                                                                            | 人に判断してほしいこと・Decisions（入口とドキュメント） |                    |
| 10  | 論点: 流し込み方。`<` を逃がして埋め込み、`textContent` で出す                                                        | Decisions（`render.mjs`・`template.html`）              |                    |
| 11  | 論点: 同じ URL への出し直しと、出す先のファイル                                                                       | Decisions（流れ）                                       |                    |
| 12  | 論点: GitHub に届かないときは `forge` の理由をページにも出す                                                          | 仮定・What Changes                                      |                    |
| 13  | 論点: 出す項目（判断待ちの理由と判断、止まり・動きなし、区切り線、PR のリンク）                                       | What Changes・Decisions（`render.mjs`）                 |                    |

## 動作確認の手順

作業するワークツリーを `$WT` とする。共有のカードを汚さないよう、`AI_BOARD_DATA` でデータ用ブランチの写し（スクラッチの bare リポジトリを `origin` にした clone）を指す（`rules.md` の「動かして確かめるとき」）。`$WT` で `npm run build` してから走らせる。

1. 今のボードからページを作れる
   - コマンド: `AI_BOARD_DATA=<写し> node $WT/dist/cli.js status --json --active --root $WT | node $WT/.claude/skills/board-view/render.mjs > $S/board-view.html`
   - 期待: 終了コード 0。HTML に `<title>` と埋め込みのデータがあり、判断待ち・AI 作業中・アイデアのカード ID が入っている
2. `</script>` を含むタイトルでも抜け出さない
   - コマンド: 1 の JSON のアイデアのタイトルを `</script><script>alert(1)</script>` に書き換えて流し込む
   - 期待: 出力の `<script>` の中に `</script>` がそのまま現れない（`</script>` になっている）
3. 壊れた入力は失敗する
   - コマンド: `echo '{}' | node $WT/.claude/skills/board-view/render.mjs`
   - 期待: 終了コード 1 で、標準エラーに理由の 1 行
4. ページの見た目（AI は公開して URL を開けるが、スマホでの見え方は人が見る）
   - コマンド: 1 の HTML を Artifact で公開する
   - 期待: 3 区画と上の帯が出る。明暗のどちらでも読める。スマホの幅で横に流れない。PR のリンクが押せる
5. 同じセッションで出し直すと同じ URL になる（共有の Artifact に出すので AI が走らせ、URL を見比べる）
   - コマンド: 1 と 4 をもう一度
   - 期待: 4 と同じ URL

## タスク

### 1. 流し込みのスクリプトとひな形

- [x] `.claude/skills/board-view/template.html` を作る（Artifact の決まりに沿った 1 枚のページ。埋め込みのデータを `textContent` で描く。データが無いときの表示）
- [x] `.claude/skills/board-view/render.mjs` を作る（純関数 `buildPageData` / `renderHtml` と、直接走らせたときの入口。入力の検査、`dist/` の文言とステージの名前でページのデータを作る、`<` と U+2028 / U+2029 を逃がして印に流し込む、誤りは終了コード 1）
- [x] テスト: `src/__tests__/board-view-render.test.ts`（`src/` の文言の関数を渡し、ページのデータに区画が入る・`</script>` が抜け出さない・`prUrl` は `https://` だけ・必要な項目が無い入力は誤り・ひな形に印がある）

### 2. スキルと入口

- [x] `.claude/skills/board-view/SKILL.md` を書く（使うとき・手順 1〜3・失敗したとき・ハードルール）
- [x] `.claude/skills/board-loop/SKILL.md` の「ボードを見せて」の節を、`board-view` のスキルでページを出すことに書き換える

### 3. ドキュメント

- [x] `docs/adr/0019-board-view-artifact.md` を書き、`docs/adr/README.md` の一覧に足し、ADR 0017 の結果に 0019 への 1 行を足す
- [x] `README.md` のボードの見方と、`CLAUDE.md` の読む場所に `board-view` のスキルを足す

## AI レビュー

- [ ] `.claude/skills/board-view/render.mjs:194` の `invokedDirectly` は、`import.meta.url`（Node が main のモジュールをシンボリックリンクを解いた実パスで持つ）と `path.resolve(process.argv[1])`（リンクを解かない）を比べている。シンボリックリンクを通った道筋で走らせると `main()` が呼ばれず、何も出さずに終了コード 0 で終わる（リンクを通して `echo '{}' | node <リンク>/.claude/skills/board-view/render.mjs` を走らせると、出力 0 バイト・終了コード 0 になるのを確かめた）。スキルの手順 2 はこれを成功と読んで空の `board-view.html` に置き換え、空のページを公開してしまう。`process.argv[1]` を `realpathSync` で実パスにしてから比べる（`realpathSync` が失敗したら直接走らせていないとみなす）
