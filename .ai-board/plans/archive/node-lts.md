# Node の LTS（24）でも ai-board を動かせるようにする

## 提案

### Why

研修の受講者には、Node 26 を入れにくい人がいる（会社の PC で入れられる版が決まっている、など）。
いまは `package.json` の `engines` が `>=26.0.0` で、CI も 26 だけで回している。

26 に絞ったのは `c12a324`（chore: 対応する Node を 26 以上に絞る）で、理由は「個人用のローカルツールとして CI と engines を揃える」ためだった。
技術的な理由ではない。カードの保存（と移行前の DB の読み込み）に使う `node:sqlite` は 24 でも使え、絞る前の CI は 22 / 24 / 26 で通っていた。

計画を書く前に、`main`（`7b37ad3`）のまま Node 24.22.1 で `npx vitest run` を走らせ、38 ファイル 835 件が通ることを確かめた。
絞った後の 93 コミットでも、24 で動かなくなる変更は入っていないと見てよい（確かめはタスクで CI に任せる）。

### What Changes

使う人から見た変化は次のとおり。

- Node 24 の環境で `npm install` しても、`engines` の不一致の警告が出なくなる
- README の「使い方」の先頭に、動かす前提（Node 24 以上）が書かれる

中の仕組みの変化は次のとおり。

- `package.json` の `engines.node` を `>=24.0.0` に広げる
- CI（`.github/workflows/ci.yml`）を `node-version` のマトリクス `['24', '26']` にする
- `@types/node` を 24 系（`^24.x`）に戻す。26 にだけある API を型の上で使えなくし、使っていれば `typecheck` で落ちるようにする
- `package-lock.json` を合わせて更新する

### Impact

- `package.json`、`package-lock.json`
- `.github/workflows/ci.yml`
- `README.md`（動かす前提）
- コードの変更は見込まない。`@types/node` を下げて `typecheck` が落ちたときだけ、その箇所を 24 にある API で書き直す
- カードの形・API・データ用ブランチの形は変わらない

## 設計

### Decisions

#### 下限は 24.0.0 にする（22 は戻さない）

カードの依頼は「LTS（24）で動かしたい」である。2026-11 の時点で 22 は保守の終わりが近く、戻すと CI の行が増えるだけで依頼に対する得が無い。
24 の中の細かい下限（`24.x.y`）は、`node:sqlite` の `DatabaseSync` が 24.0 で使えるので切らない。
CI は各メジャーの最新を使うため、24.0 そのものは CI で確かめない。ここは Risks に書く。

#### CI はマトリクスで 24 と 26 を並べる

下限（24）と、手元で使う版（26）の両方を通す。`c12a324` で外す前のマトリクスと同じ形に戻す。
`test:coverage` と `build` も両方の行で走らせる（行ごとに分けて省くと、片方でしか落ちない壊れ方を見逃すため）。

#### `@types/node` は下限の 24 系に合わせる

型を上限の 26 系にしておくと、26 にだけある API を使っても `typecheck` が通り、24 で動かしたときに初めて落ちる。
下限に合わせておけば、型の検査で先に気づける。26 の行の CI は実行時に 26 で動くことを確かめる。

#### `cli.ts` の `ExperimentalWarning` を黙らせる処理は残す

`src/cli.ts` のコメントにあるとおり、`node:sqlite` は 24 では実験的扱いで警告を出す。
エージェントが CLI の出力を読むので、24 を対象に戻す以上、この処理は要る。コメントも 24 に触れたままでよい。

### Risks / Trade-offs

- **24.0 そのものは確かめない:** CI は 24 系の最新で走る。24.0〜24.x の古い版でだけ壊れる API を使っていても気づけない。
  研修の PC で入る版は古い 24 のこともあるので、README には「24 以上（なるべく 24 系の最新）」と書く
- **CI の時間が倍になる:** マトリクスの 2 行が並列に走るので、待ち時間はほぼ変わらない。使う分は倍になる
- **`@types/node` を下げると、`package-lock.json` の `undici-types` などの版も下がる:** 差分は lock に閉じ、実行時の依存は変わらない

### Non-Goals

- Node 22 以前への対応
- `node:sqlite` をほかの SQLite のライブラリに置き換えること
- `.nvmrc` / `.node-version` / Volta などで Node の版を固定すること（研修の PC の事情に合わせ、版の選び方は使う人に任せる）
- `engines` を守らせる設定（`engine-strict`）を入れること

## 動作確認の手順

1. Node 24 を用意する（`nvm install 24 && nvm use 24` など）。`node --version` が `v24.` で始まることを確かめる
2. ブランチ `node-lts` を checkout し、`npm ci` を走らせる。
   期待する結果: `npm warn EBADENGINE`（engines の不一致の警告）が出ない
3. `npm run typecheck && npm run lint && npm run format:check && npm test && npm run build` を走らせる。
   期待する結果: どれも通る
4. 自分のプロジェクト（`.ai-board/` を持つもの）で `node dist/cli.js --root <プロジェクトのパス>` を起動し、開いたボードの画面にカードが並ぶことを見る。
   続けて `node dist/cli.js status --root <プロジェクトのパス>` を走らせ、`ExperimentalWarning` が出ずにステージの一覧が出ることを見る
5. PR の CI で、`check (24)` と `check (26)` の 2 行がどちらも通っていることを見る
6. README の「使い方」の先頭に、Node 24 以上が前提と書かれていることを読む

## タスク

- [x] `package.json` の `engines.node` を `>=24.0.0` にする
- [x] `@types/node` を 24 系に下げ（`npm install -D @types/node@^24`）、`package-lock.json` を更新する。`npm run typecheck` が落ちたら、その箇所を 24 にある API で書き直す
- [x] `.github/workflows/ci.yml` を `node-version: ['24', '26']` のマトリクスにし、`engines` に合わせる旨のコメントを直す
- [x] README の「使い方」の先頭に、動かす前提（Node 24 以上、なるべく 24 系の最新）を書く
- [x] Node 24 と 26 の両方で、品質ゲートと `npm run build` が通ることを確かめる（手元に無い版は CI で確かめる）

## AI レビュー

指摘なし
