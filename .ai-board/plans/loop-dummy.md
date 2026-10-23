# README に `ai-board status` の出力例を足す（board-loop の動作確認用のダミー）

## 提案

### Why

このカードは `board-loop` スキルの動作確認のためのダミーで、マージしない。
ループが計画を書き、Draft の PR を出し、`plan 提出` を書いたところで止まることを確かめる。

題材として、README の「AI ループ」の節に `ai-board status` の人向けの出力例を 1 つ足す。
今の README は `status` が何を出すかを文章でしか説明しておらず、判断待ち / AI 作業中 / 次の一手 の並びが読み手に伝わりにくい。

### What Changes

- README の「AI ループ」の節（`status` を読むには〜の段落の直後）に、`ai-board status` の出力例をコードブロックで 1 つ足す

### Impact

- 変更: `README.md` だけ。コードとテストには触らない

## 設計

### Decisions

#### 置き場所は「AI ループ」の節にする

カードには「README の末尾」とあるが、README の末尾は「ライセンス」の節である。
出力例は `status` の説明の近くにある方が読み手が探さずに済むので、「AI ループ」の節に置く。

#### 出力例は実際の出力から作る

手で書くと、見出しや区切りの書式が実装とずれる。`node dist/cli.js status` の実際の出力を貼り、カード ID とタイトルだけを架空のものに置き換える。

### Risks / Trade-offs

- **出力の書式が変わると README が古くなる。** `formatStatus` を変えるときは README も直す必要がある。例は 1 つに留めて、直す手間を小さくする

### Non-Goals

- `status --json` の出力例（項目が多く、README に貼ると長くなる）
- このダミーの PR のマージ

## タスク

- [ ] `node dist/cli.js status` の実際の出力から、カード ID とタイトルを架空のものに置き換えた例を作る
- [ ] README の「AI ループ」の節に、その例をコードブロックで足す
