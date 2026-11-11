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
列はカード、`.ai-board/plans/` の計画ファイル、GitHub の PR の実態から導くので、列を直接動かす操作は無い。

この README は、自分の GitHub に ai-board を用意して、最初のチケットを 1 枚マージするまでの手順を書く。
仕組みの説明（列の決まり方、止まり、人の判断、AI ループ）は [`docs/reference.md`](docs/reference.md) にある。

## 1. 準備する

### 要るもの

- Node 24 以上と git
- GitHub の CLI（`gh`）。`gh auth login` でログインしておく。ai-board はアクセストークンを受け取らず、PR の問い合わせを `gh api` に任せる
- Claude Code

### fork して clone する

GitHub でこのリポジトリを fork する。
fork の画面の「Copy the `main` branch only」は入れたままにする（元のリポジトリのカードの置き場所である `ai-board/data` ブランチを持ち込まないため）。

```bash
git clone https://github.com/<you>/ai-board.git
cd ai-board
npm ci
npm run build
```

以下のコマンドはどれも、この clone（メインのチェックアウト）の根で打つ。
CLI は `node dist/cli.js` で動かす。

### 接続先を書く

```bash
cp .ai-board/config.example.yaml .ai-board/config.yaml
```

`.ai-board/config.yaml` の `repository` を自分の fork（`<you>/ai-board`）に書き換える。
このファイルは git に載らない。

### カードの置き場所を作る

```bash
node dist/cli.js init
```

空の `ai-board/data` ブランチを作って fork に push し、`config.yaml` をその根へ写す。
カードはこのブランチに置かれ、手元では `.ai-board/data/` に展開される。
ほかの人が同じ fork を clone したときは、最初に CLI を動かした時点で展開されるので、`init` は 1 回だけでよい。

```bash
node dist/cli.js status
```

「GitHub: 接続済み」と出れば準備は済んでいる。
接続できないときは、その理由がこの行に出る。

## 2. カードを入れる

### 元のリポジトリのカードを移す

元のリポジトリの clone で、カードを 1 枚 1 ファイルに書き出す。
書き出すのは、着手しておらず中止もしていないカードだけである。

```bash
# 元のリポジトリの clone で（読むだけで、カードは変わらない）
node dist/cli.js card export --to ~/backlog
```

自分の fork の clone で、書き出したファイルからカードを起票する。

```bash
# 自分の fork の clone で
node dist/cli.js card seed --from ~/backlog
```

書き出したファイルは `<id>.md` で、タイトルと本文だけを持つ。
要らないカードは、`seed` の前にそのファイルを消しておけばよい。
並び順と、元のリポジトリでの判断は移らない（詳しくは [リファレンス](docs/reference.md#別のリポジトリへカードを移す)）。

### 新しくカードを書く

本文を標準入力から渡して起票する。
日本語だけのタイトルからは読みやすい ID が作れないので、`--id` で短い kebab-case を付けておく。

```bash
node dist/cli.js card create --title 'ユーザは、status で列ごとの枚数を見たい' --id status-stage-counts <<'EOF'
## アイデア

status の人向けの出力の先頭に、列ごとのカードの枚数を出す。

## 背景

今は判断待ちと AI 作業中しか見えず、ボード全体の量が分からない。
EOF
```

起票したカードはアイデアの列の末尾に付く。
`node dist/cli.js card list` で一覧を、`card show <id>` で 1 枚を読める。

## 3. 最初のチケットを進める

ここからは Claude Code のチャットで進める。
clone の根で Claude Code を開き、日本語で頼めばよい。
人の判断は `board-decide` のスキルが、AI の手は `board-loop` のスキルが受け持つ。

### 着手する

> status-stage-counts に着手して

着手を書くと、カードは計画提案中に移る。
同じセッションで AI の番が続き、AI は計画（`.ai-board/plans/status-stage-counts.md`）を書いてブランチに載せ、Draft の PR を出す。
カードは計画レビューに移り、人の番で止まる。

### 計画を読んで判断する

Draft の PR で計画を読む。
計画には方針、動作確認の手順、タスクのチェックボックスが並ぶ。

> status-stage-counts の計画を承認して

直してほしいところがあれば差し戻す。
差し戻しには理由が要る。

> status-stage-counts を差し戻して。理由は、枚数に中止のカードを含めないでほしい

差し戻すと、AI が計画を直して出し直し、また計画レビューで止まる。

### 実装を待つ

承認すると、カードは実装中に移り、AI が同じ PR の上で次の順に進める。

1. 計画のタスクを上から倒し、節ごとにコミットする
2. 実装を書いた文脈を持たないサブエージェントが差分を読み、指摘を計画の末尾に書く
3. 直すと決めた指摘をタスクと同じに倒す
4. 動作確認の手順どおりに動かして結果を PR の本文に書き、計画を `plans/archive/` へ移して PR を Ready にする

途中で手が止まったら、チャットで `/board-loop` と打つと続きから進む。

### PR を読んでマージする

PR が Ready になると、カードは PR中 に移る。
PR の本文の「動作確認の結果」と差分を読み、よければ GitHub でマージする。
マージすると、カードはマージ済みに移る。

直してほしいところがあれば、PR にコメントを書いて `/board-loop` と打つ。
AI は Ready のまま修正を push するか、直さない理由を返信する。

### ボードを見る

```bash
node dist/cli.js status
```

判断待ち、AI 作業中、次の一手が出る。
チャットで「ボードを見せて」と頼むと、`board-view` のスキルがボードを 1 枚のページにして開く。

## 次に読むもの

- 列の決まり方、止まり、出せる判断、AI ループの手、許可ルール、クラウドや Windows で回すとき、オフラインの研修: [`docs/reference.md`](docs/reference.md)
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

## ライセンス

MIT License. 詳細は [LICENSE](LICENSE) を参照。
