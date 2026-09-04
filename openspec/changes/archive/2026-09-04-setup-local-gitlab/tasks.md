## 1. 秘匿情報の穴を先に塞ぐ

- [x] 1.1 `.gitignore` に `.env` を追加し、`git check-ignore -v .env` がその行を指すことを確認する
- [x] 1.2 `.env.example` を作成して `GITLAB_ROOT_PASSWORD=` の雛形を置く。`.env` を作った上で
      `git status --short` に `.env.example` だけが現れ `.env` が現れないことを確認する

## 2. GitLab を起動する

- [x] 2.1 リポジトリ直下に `compose.yaml` を作成する。`gitlab/gitlab-ce` の単一サービス、
      `/etc/gitlab`・`/var/log/gitlab`・`/var/opt/gitlab` を名前つきボリュームに割り当て、
      `GITLAB_ROOT_PASSWORD` を `.env` から受ける。`docker compose config` が
      エラーなく解決結果を出力することを確認する
- [x] 2.2 `GITLAB_OMNIBUS_CONFIG` に `external_url 'http://localhost:8080'`、
      prometheus / grafana / registry の無効化、puma ワーカー数と sidekiq 並列度の抑制を書く
- [x] 2.3 healthcheck を定義し、`docker compose up -d` の後 `docker compose ps` が
      `healthy` に遷移することを確認する（初回は数分かかる）
- [x] 2.4 **ポートマッピングを実測で確定した。** 結果は当初の想定と異なる。
      nginx は `external_url` のポートに追随して待ち受けるため同一ポートのマッピングが正しいが、
      **8080 は使えない**。omnibus の puma が既定で `127.0.0.1:8080` に bind するため
      nginx と衝突し、puma が EADDRINUSE で無限に再起動して nginx だけが 502 を返し続ける。
      採用: `external_url 'http://localhost:8929'` + `8929:8929`。
      検証は `/-/health` ではなく `curl -s -o /dev/null -w '%{http_code}' http://localhost:8929/users/sign_in`
      が 200 を返すことで行う（`/-/health` は `monitoring_whitelist` により
      コンテナ内からは 200、ホストからは 404 になるため疎通判定に使えない）
- [x] 2.5 常駐メモリを実測した: **2.42 GiB**（Docker VM の 15.58 GiB 中 15.5%）。
      カードが懸念していた 4GB を下回り、常時起動は現実的と判断する。
      内訳上位は puma / sidekiq の ruby 各約 0.95 GiB、gitaly 約 0.34 GiB。
      この値は 7.1 で README に残す

## 3. 認証情報とプロジェクトを用意する

- [x] 3.1 `gitlab-rails runner` で `api` スコープの PAT を発行する手順を確立する。
      得たトークンで `curl -H 'PRIVATE-TOKEN: ...' http://localhost:8080/api/v4/user` が
      200 を返すことを確認する。動かなければ Web UI 発行に切り替え、どちらの手順も README に残す
- [x] 3.2 Projects API で ai-board 用プロジェクトを作成する。
      `curl -H 'PRIVATE-TOKEN: ...' http://localhost:8080/api/v4/projects/root%2Fai-board` が
      200 を返すことを確認する（パス形式で解決できることの確認）

## 4. 検証用の MR を GitLab API だけで作る

ローカルからの `git push` は行わない（`git remote` の設定は `gitlab-mr-loop` のスコープ）。

- [x] 4.1 Files API で既定ブランチにファイルを 1 つコミットし、リポジトリを空でない状態にする。
      `GET /projects/:id/repository/branches` が既定ブランチを 1 本返すことを確認する
- [x] 4.2 Branches API で検証用ブランチを切り、Commits API でそのブランチにコミットを 1 つ足す。
      `GET /projects/:id/repository/commits?ref_name=<branch>` が 2 件以上返すことを確認する
- [x] 4.3 Merge Requests API で MR を作成し、`GET /projects/:id/merge_requests?state=opened` が
      1 件返すことを確認する。返却された `iid` と `web_url` を記録する

## 5. ボードを接続する

- [x] 5.1 `.ai-board/config.yaml` を作成し `gitlab.url` と `gitlab.projectId`
      （`"root/ai-board"` 形式）を設定する。このファイルは追跡するため、
      `git status --short` に現れることを確認する。`npm test` が引き続き 145 件通ることも確認する
- [x] 5.2 `AI_BOARD_GITLAB_TOKEN` を設定した上でボードを起動し、
      `curl -s localhost:<port>/api/board | jq .gitlab` が `{"status":"connected"}` を
      返すことを確認する
- [x] 5.3 カードの `branch` に 4.2 のブランチ名を書き、`fetchByBranch()` 経由で `mr` の iid が
      解決され、4.3 で記録した iid と一致することを確認する

## 6. 疎通の真偽を確かめる

- [x] 6.1 **`web_url` の到達性を独立に検証する。** `/api/board` が返す該当カードの `mr.webUrl` を
      そのままブラウザで開き、対象の MR ページが表示されることを確認する。
      ボードの列が埋まっていることを疎通の根拠にしない（`external_url` の誤設定は
      API 200 のまま `web_url` だけを壊すため）
- [x] 6.2 ボード上で該当カードが AI-PR 列に出ること、`reason` が MR 由来であることを確認する
- [x] 6.3 `docker compose stop` した状態でボードを再読み込みし、ボードが落ちず接続状態が
      `error` を表示することを確認する。`docker compose start` で `connected` に復帰することも確認する

## 7. 手順を残す

- [x] 7.1 README に「ローカル GitLab」の節を追加する。compose が起動するのは GitLab だけで
      ai-board 本体は npm で動かすこと、`.env` の用意、PAT 発行、疎通確認のコマンド列、
      2.4 と 2.5 の実測値を含める
- [x] 7.2 `.ai-board/cards/gitlab-docker.md` の「未検証」3 点を実測値に置き換える
- [x] 7.3 `npm run typecheck && npm run lint && npm test` がすべて通ることを確認する
