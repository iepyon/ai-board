# 3. GitHub は `gh` に認証を委ね、外部コマンドは shell を介さずに実行する

- 状態: 採用
- 日付: 2026-09-21

## 背景

GitHub の PR を取得先に足すとき、それまでの GitLab 連携は Personal Access Token を環境変数で受け取っていた。
利用者の手元には `gh` がログイン済みであり、ローカル専用ツールのためにトークンの発行と管理を強いる理由が無かった。
一方、問い合わせに使うカードの `branch` は人もエージェントも自由に書ける文字列だった。

## 決定

- **ai-board はアクセストークンを受け取らない・持たない・記録しない。** 問い合わせは `gh api` をサブプロセスで実行し、認証は CLI のログインに委ねる。
- CLI が無い・未ログインなら連携を無効にして理由を出し、ボードは落とさない。
- **外部コマンドは `src/infrastructure/cli-runner.ts` に閉じ、`execFile` で shell を介さず引数を配列で渡す。** タイムアウトと出力の上限を付ける。
- 失敗は `Result` の union で返し、stderr の本文は載せない（資格情報が混ざる余地を断つ）。

## 結果

- 利用者は資格情報を ai-board に渡さなくてよい。代わりに `gh` のインストールとログインが前提になった。
- `branch` にシェルの特殊文字を入れてもコマンドにならない。git の操作（計画の `git show`・データ用ブランチ）も cli-runner を通る。
- 問い合わせは 1 回約 0.4 秒遅くなる。
- クラウドでは `gh auth status` と GraphQL が使えないので、接続の確かめは `gh api repos/...` に、`gh pr` は REST の `ai-board pr` に置き換えた（`pr ready` だけは REST で Draft を外せないので `gh pr ready` を先に試す）（[10](0010-cards-on-data-branch.md)）。

## 退けた案

- **`gh auth token` でトークンを取り出して `fetch` する** — トークンをメモリに載せた時点で「扱わない」にならない。

根拠: `.ai-board/plans/archive/github-pr-provider.md`、`cf402fc`、`8566331`、`CLAUDE.md`「設計の不変条件」
