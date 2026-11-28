# ai-board

計画ファイル駆動の開発のためのボード。
カードは人が起票し、AI エージェントが計画を書いて実装し、人は計画と PR の 2 か所で判断する。
`ai-board` の CLI と Claude Code のチャット（スキル）で扱う。

```
[ アイデア ] [ 計画提案中 ] [ 計画レビュー ] [ 実装中 ] [ PR中 ] [ マージ済み ]
     人            AI            人 ★          AI        人 ★        —
```

★ が人の判断を待つ列である。
人が動かすのはアイデアから計画提案中への「着手」だけで、そこから先は AI が右へ進め、★ で止まる。
列はカード、計画ファイル（`.ai-board/cards/<id>/plan.md`）、GitHub の PR の実態から導くので、列を直接動かす操作は無い。

この README は、自分の GitHub に ai-board を用意して、最初のチケットを 1 枚マージするまでの手順を書く。
仕組みの説明（列の決まり方、止まり、人の判断、AI ループ）は [`docs/reference.md`](docs/reference.md) にある。

## 頼み方とコマンド

どの手順も、Claude Code のチャットで日本語で頼むか、CLI のコマンドを打つかのどちらかで進められる。
この README では、各手順に両方を並べる。

- **チャットで頼む**：clone の根で Claude Code を開き、引用の形（`>`）で示した文を送る。文面は例で、同じ意味なら言い回しは変えてよい
- **コマンドで打つ**：clone の根で `node dist/cli.js ...` を打つ

人の判断（着手、承認、差し戻し）は `board-decide` のスキルが、AI の手（計画、実装、締め）は `board-loop` のスキルが受け持つ。
AI の手にはコマンドが無く、チャットで頼むだけになる。

## 1. 準備する

### 要るもの

- Node 24 以上と git
- GitHub の CLI（`gh`）。`gh auth login` でログインしておく。ai-board はアクセストークンを受け取らず、PR の問い合わせを `gh api` に任せる
- Claude Code（チャットで頼むときと、AI の手を進めるときに使う）。clone の根で開く。AI の手は auto モードで回す前提で、権限の確認が毎回出ると手が止まる（[リファレンス](docs/reference.md#ループの許可ルール)）
- ボードを使う全員が、自分の fork（か共有のリポジトリ）の `main` に直接 push できること。カードは `main` の `.ai-board/` に置き、CLI が書き込みのたびに push する

### fork して clone する

GitHub でこのリポジトリを fork する。
fork の画面の「Copy the `main` branch only」は入れたままでよい（カードは `main` の `.ai-board/` に置く）。
`main` に PR 必須のブランチ保護を入れない（CLI がカードの書き込みを直接 push するため）。force push の禁止は入れてよい。

```bash
git clone https://github.com/<you>/ai-board.git
cd ai-board
```

ここから先は、この clone（メインのチェックアウト）の根で進める。

main は開発の途中の状態で、手順と実装が食い違っていることがある。
動くと確かめた版にはタグを打ち、[Releases](https://github.com/iepyon/ai-board/releases) にこの版でできることを書いてある。
今あるタグは `artifact-store-v1` だけで、カードを claude.ai の Artifact の DB に置いていた前の版である。**この README の手順（カードを `main` に置く）とは違うので、合わせない。** この README は、clone したそのままの `main` で進める。

この README に対応するタグ（例: `git-store-v1`）が Releases に出たら、決まった版から始められる。
その場合は、次のビルドの前に自分の main をそのタグに合わせる（`<tag>` は Releases の名前）。force push するので、fork の `main` に force push の禁止を入れる前に行う。
Claude の許可ルールが `main` への push を止めているので、この `git push` は自分の端末で打つ（チャットには頼めない）。

```bash
git fetch https://github.com/iepyon/ai-board.git tag <tag>
git reset --hard <tag>
git push --force origin main
```

### 依存を入れてビルドする

> 依存を入れて CLI をビルドして

```bash
npm ci
npm run build
```

### 接続先を書く

git に載っている `.ai-board/config.yaml` の `github.repository` を、自分の fork に書き換えて main に入れる。
PR を問い合わせる先になる。
カードは、この `github.repository` の Issue に置く（ラベル `ai-board`）。`gh` にログイン済みで、そのリポジトリの Issue を読み書きできることが要る。
マージ済みの計画を読む場所は `store.remote` / `store.branch`（既定は `origin` の `main`）で、ふつうは書き換えない。

> .ai-board/config.yaml の repository を <you>/ai-board にして、main にコミットして

```bash
git add .ai-board/config.yaml
git commit -m 'chore: github.repository を自分の fork にする'
git push origin main
```

Claude の許可ルールは Bash からの `main` への push を止めている（`.claude/settings.json`。[リファレンス](docs/reference.md#ループの許可ルール)）。
書き換えとコミットはチャットで頼めるが、`git push origin main` は自分の端末で打つ。

### カードの置き場所を作る

カードは、`github.repository` の Issue に置く（1 枚 1 Issue。判断は Issue のコメント、並び順と形の版は専用の Issue）。
CLI は読むたびに `gh api` で Issue を引き、書き込みも `gh api` で Issue とコメントに書く。git には何も書かないので、`main` にカードのコミットは入らない。
人も Claude も、Issue の本文の末尾の隠しコメントと判断のコメントを手で書き換えない。読み書きは `ai-board card` / `decide` で行う。
Issue の画面では、カードを読む・コメントする・ラベルや検索で探すのは自由にできる（タイトルを直せばカードのタイトルになる）。
しくみと、なぜこう置くのかは [リファレンス](docs/reference.md#カード) と [ADR 0021](docs/adr/0021-cards-as-github-issues.md) にある。

> 置き場所を用意して

```bash
node dist/cli.js store init   # 置き場所の Issue（形の版と空の並び順）を作る
```

用意はカードの無いボードで終わる。カードは次の「2. カードを入れる」で入れる（`.ai-board/seed/*.md` の最初のカードが Issue になる）。
計画はこれまでどおりカードのブランチから PR で `main` に入る。手元の `main` を追いつかせるときは `git pull` を打つ。`git pull` で `src/` が新しくなったら `npm run build` も走らせる（CLI は `dist/` が古いと止まる）。

### つながったかを確かめる

> ボードの状態を見せて

```bash
node dist/cli.js status
```

```text
GitHub: 接続済み
ループ: 記録なし

判断待ち (0)

AI 作業中 (0)

次の一手: なし（AI が進められるカードはありません）
```

「GitHub: 接続済み」と出れば準備は済んでいる。カードが 0 枚なので、判断待ちも AI 作業中も 0 になる。
接続できないときは、その理由がこの行に出る（`gh auth login` 済みか、`config.yaml` の `github.repository` が自分の fork かを確かめる。つまずきの一覧は [`docs/verification.md`](docs/verification.md#トラブルシュート)）。

## 2. カードを入れる

### 最初のアイデアカードを入れる

`.ai-board/seed/` に、このチュートリアルの題材のカード（`status-stage-counts`）と、ai-board 自身のアイデアのカード 9 枚（計 10 枚）が置いてある。

> 最初のアイデアカードを入れて

```bash
node dist/cli.js store seed   # 既定は .ai-board/seed/。既にある ID は飛ばす
```

起票したカードは、`.ai-board/seed/order.txt` の順（書いていない題材はその後にファイル名の順）でアイデアの列の末尾に付く。起票は `main` へのコミットとして push される。
ターミナルの `status` はアイデアを出さないので（カードを入れても出力は変わらない）、入ったことは `node dist/cli.js card list`（10 件）か「ボードを見せて」で確かめる。
研修の題材を増やすときは、`.ai-board/seed/` に `<id>.md`（frontmatter に `id` と `title`、本文は自由）を足し、並べたい位置に合わせて `order.txt` に ID を書く。

### 新しくカードを書く

やりたいことと、その理由を伝えて起票する。
日本語だけのタイトルからは読みやすい ID が作れないので、短い kebab-case の ID を付けておくと後で指しやすい。

> 「ユーザは、status で中止のカードの枚数も見たい」というアイデアカードを、ID を status-aborted-count にして起票して。
> やることは、列ごとの枚数の隣に中止のカードの枚数を出すこと。
> 背景は、片付けたカードがどれだけあるかが分からないこと。

```bash
node dist/cli.js card create --title 'ユーザは、status で中止のカードの枚数も見たい' --id status-aborted-count <<'EOF'
## アイデア

列ごとの枚数の隣に、中止のカードの枚数を出す。

## 背景

片付けたカードがどれだけあるかが分からない。
EOF
```

起票したカードはアイデアの列の末尾に付く。

> アイデアの一覧を見せて

```bash
node dist/cli.js card list              # 一覧（JSON）
node dist/cli.js card show <id>         # 1 枚を Markdown で
```

## 3. 最初のチケットを進める

### 着手する

> status-stage-counts に着手して

```bash
node dist/cli.js decide start status-stage-counts
```

着手を書くと、カードは計画提案中に移る（`status` の AI 作業中に出る）。
チャットで頼んだときは、同じセッションで AI の番が続き、AI は計画（`.ai-board/cards/status-stage-counts/plan.md`）を書いてブランチに載せ、Draft の PR を出す。
コマンドで着手したときは、チャットで AI の番を始める。

> ボードを進めて

カードは計画レビューに移り、人の番で止まる。`status` の判断待ちに出て、出せる判断（承認 / 差し戻す / 中止）が付く。

> 判断待ちを見せて

### 計画を読んで判断する

Draft の PR で計画を読む。PR はカードのブランチ（`node dist/cli.js card show status-stage-counts` の `branch`）の PR で、GitHub の Pull requests に Draft として並ぶ。
計画には方針、動作確認の手順、タスクのチェックボックスが並ぶ。
よければ承認する。

> status-stage-counts の計画を承認して

```bash
node dist/cli.js decide approve status-stage-counts
```

直してほしいところがあれば差し戻す。
差し戻しには理由が要る。

> status-stage-counts を差し戻して。理由は、枚数に中止のカードを含めないでほしい

```bash
node dist/cli.js decide reject status-stage-counts --reason '枚数に中止のカードを含めないでほしい'
```

差し戻すと、AI が計画を直して出し直し、また計画レビューで止まる。
ここでも、チャットで頼めば AI の番がそのまま続き、コマンドで書いたときは「ボードを進めて」と頼む。

### 実装を待つ

承認すると、カードは実装中に移り、AI が同じ PR の上で次の順に進める。

1. 計画のタスクを上から倒し、節ごとにコミットする
2. 実装を書いた文脈を持たないサブエージェントが差分を読み、指摘を計画の末尾に書く
3. 直すと決めた指摘をタスクと同じに倒す
4. 動作確認の手順どおりに動かして結果を PR の本文に書き、計画の末尾に `## 締め` の節を足して PR を Ready にする

途中で手が止まったら、続きを頼む。

> ボードを進めて

`/board-loop` と打っても同じである。

### PR を読んでマージする

PR が Ready になると、カードは PR中 に移る。
PR の本文の「動作確認の結果」と差分を読み、よければ GitHub でマージする。
マージすると計画が `main` に入り、カードはマージ済みに移る。
マージの後は `git pull` で手元の `main` を追いつかせ、`node dist/cli.js status` で判断待ちから消えたことを、`card list` ではカードが残っていることを確かめる（マージ済みのカードはカードのファイルのまま残る）。

直してほしいところがあれば、PR にコメントを書いてから続きを頼む。
AI は Ready のまま修正を push するか、直さない理由を返信する。

> PR にコメントを書いたので、ボードを進めて

### ボードを見る

判断待ち、AI 作業中、次の一手を見る。

> 判断待ちを見せて

```bash
node dist/cli.js status
```

ボード全体を 1 枚のページで見るときは、チャットで頼む（`board-view` のスキルが `.ai-board/local/board.html` に書き出す。ブラウザで開いて見る）。

> ボードを見せて

## 次に読むもの

- 列の決まり方、止まり、出せる判断、AI ループの手、許可ルール、クラウドや Windows で回すとき: [`docs/reference.md`](docs/reference.md)
- 設計判断の理由と捨てた代案: [`docs/adr/`](docs/adr/)
- 仕様: `docs/specs/`
- コマンドの一覧: `node dist/cli.js --help` と `node dist/cli.js <command> --help`

## 開発

```bash
npm run typecheck && npm run lint && npm run format:check && npm test   # 品質ゲート（整形は npm run format）
npm run test:coverage   # 閾値は lines / functions / statements 80%、branches 75%
npm run build
```

CI（`.github/workflows/ci.yml`）は Actions の画面から手で起動したときだけ走る。PR のレビューだけに効く指示は `REVIEW.md` にある。

動くと確かめた main のコミットには、注釈付きのタグを打って GitHub の Release を作る。
タグの名前は、その版の置き場所や仕組みが分かるものにする（例: `artifact-store-v1`、`git-store-v1`）。

## ライセンス

MIT License. 詳細は [LICENSE](LICENSE) を参照。
