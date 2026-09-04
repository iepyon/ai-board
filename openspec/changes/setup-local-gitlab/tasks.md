## 1. 秘匿情報の穴を先に塞ぐ

- [ ] 1.1 `.gitignore` に `.env` を追加し、`git check-ignore -v .env` が
      当該行にマッチすることを確認する（`.env` を作る前に必ず済ませる）
- [ ] 1.2 `.env.example` を作成し `GITLAB_ROOT_PASSWORD=` の雛形を置く。
      `git status` に `.env.example` だけが現れ `.env` が現れないことを確認する

## 2. GitLab を起動する

- [ ] 2.1 リポジトリ直下に `compose.yaml` を作成する。`gitlab/gitlab-ce` の単一サービス、
      `/etc/gitlab`・`/var/log/gitlab`・`/var/opt/gitlab` を名前つきボリュームに割り当て、
      `GITLAB_ROOT_PASSWORD` を `.env` から受ける。`docker compose config` が
      エラーなく解決結果を出力することを確認する
- [ ] 2.2 `GITLAB_OMNIBUS_CONFIG` に `external_url 'http://localhost:8080'` と、
      prometheus / grafana / registry の無効化、puma ワーカー数と sidekiq 並列度の抑制を書く
- [ ] 2.3 healthcheck を定義し、`docker compose up -d` の後 `docker compose ps` が
      `healthy` に遷移することを確認する（初回は数分かかる）
- [ ] 2.4 **ポートマッピングを実測で確定する。** `external_url` にポートを含めた場合に
      コンテナ内部が待ち受けるポートを `docker compose exec` で確認し、`8080:8080` と
      `8080:80` のどちらが正しいかを決める。`curl -sf http://localhost:8080/-/health` が
      通ることを確認する
- [ ] 2.5 `docker stats --no-stream` で常駐メモリを記録する。想定を大きく超える場合は
      常時起動を諦め「使うときだけ上げる」運用に切り替え、その判断を README に書く

## 3. 認証情報とプロジェクトを用意する

- [ ] 3.1 `gitlab-rails runner` で `api` スコープの PAT を発行するコマンドを確立する。
      発行したトークンで `curl -H 'PRIVATE-TOKEN: ...' http://localhost:8080/api/v4/user` が
      200 を返すことを確認する。動かなければ Web UI 発行にフォールバックし、
      どちらの手順も README に残す
- [ ] 3.2 GitLab 上に ai-board 用のプロジェクトを作成する。空リポジトリだと MR を作れないため、
      Files API で README を 1 つコミットして既定ブランチを生やす。
      `curl -H 'PRIVATE-TOKEN: ...' http://localhost:8080/api/v4/projects/root%2Fai-board` が
      200 を返すことを確認する（名前空間つきパスで解決できることの確認）

## 4. ボードを接続する

- [ ] 4.1 `.ai-board/config.yaml` を作成し `gitlab.url` と `gitlab.projectId`
      （`"root/ai-board"` 形式の文字列）を設定する。このファイルは秘密を含まないため
      追跡する。`git status` に現れる（＝ignore されていない）ことと、
      `npm test` が引き続き通ることを確認する
- [ ] 4.2 `export AI_BOARD_GITLAB_TOKEN=...` の上で ai-board を起動し、
      `curl -s localhost:<port>/api/board | jq .gitlab` が
      `{"status":"connected"}` を返すことを確認する
- [ ] 4.3 検証用の MR を 1 本、**GitLab API だけで**作る。ローカルからの push は行わない
      （`git remote` の設定は `gitlab-mr-loop` のスコープ）。Branches API で既定ブランチから
      ブランチを切り、Commits API でそのブランチにコミットを 1 つ足し、
      Merge Requests API で MR を作成する。`state` が `opened` の MR が
      1 件返ることを確認する
- [ ] 4.4 カードの `branch` に 4.3 のブランチ名を書き、`fetchByBranch()` 経由で
      `mr` の iid が解決されてカードに書き戻されることを確認する

## 5. 疎通の真偽を確かめる

- [ ] 5.1 **`web_url` の到達性を独立に検証する。** `curl -s localhost:<port>/api/board` が返す
      該当カードの `mr.webUrl` をそのままブラウザで開き、対象の MR ページが表示されることを
      確認する。ボードの列が埋まっていることを根拠にしない（`external_url` 誤設定は
      API 200 のまま `web_url` だけを壊すため）
- [ ] 5.2 ボード上で当該カードが AI-PR 列に出ることを確認する
- [ ] 5.3 `docker compose stop` した状態でボードを再読み込みし、ボードが落ちず
      接続状態が `error` を表示することを確認する。`docker compose start` で復帰することも確認する

## 6. 手順を残す

- [ ] 6.1 README に「ローカル GitLab」の節を追加する。compose が起動するのは GitLab だけで
      ai-board 本体は npm で動かすこと、`.env` の用意、PAT 発行、疎通確認のコマンド列、
      2.4 と 2.5 で実測した値を含める
- [ ] 6.2 `npm run typecheck && npm run lint && npm test` が通ることを確認する
- [ ] 6.3 `.ai-board/cards/gitlab-docker.md` の未検証 3 点を実測値で置き換える
