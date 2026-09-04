---
id: gitlab-docker
title: Docker Compose で GitLab を立てて接続する
created: '2026-09-04T06:48:23.390Z'
explored: true
implStartedAt: null
change: setup-local-gitlab
branch: setup-local-gitlab
mr: 1
stageOverride: null
---

## アイデア

AI-PR / AI-PR 修正済みの 2 列は GitLab の MR 状態から導出しているが、繋ぐ先が無いため常に空のままになっている。ローカルに GitLab を立てて開通させる。

## 探索メモ

- ai-board 側の実装はスタブサーバで全ステージ遷移まで検証済み。必要なのは url / projectId / トークンの 3 つだけ
- 使う API は 4 本のみ（MR 取得 / branch 解決 / notes / commits）。GitLab 側に特別な設定は要らない
- `gitlab/gitlab-ce` は起動に数分かかり、メモリも 4GB 前後を要求する。開発機で常時上げるのは重い
- トークンは `AI_BOARD_GITLAB_TOKEN` 環境変数から読む。設定ファイルには書かない
- `gitlab/gitlab-ce` は **arm64 ネイティブイメージがある**。この機体（arm64 / macOS 26.6.2）で
  エミュレーションによる激遅は起きない。残る負荷はメモリだけ
- **`git remote -v` が空**。GitLab を立てても push 先が無いので MR は 1 本も生まれない。
  実データで列を埋めるところは `gitlab-mr-loop` カードに分離した
- Gitea / Forgejo への逃げは効かない。`HttpGitLabClient` は GitLab REST API v4 決め打ち
  （`/api/v4/projects/:id/merge_requests`、`PRIVATE-TOKEN`）で、Gitea は `/api/v1/.../pulls` と別系統。
  乗り換えるならクライアントにアダプタ層が要る＝別の change
- **`external_url` の設定ミスは沈黙する。** `HttpGitLabClient.enrich()` は GitLab の `web_url` を
  そのまま `MrState.webUrl` に載せ、ボードはそれをリンクにする。誤設定でも API は 200 を返すため
  列は埋まり、リンクだけが壊れる。疎通確認には「返ってきた `web_url` が実際に開けるか」を含める
- 決めたこと:
  - compose はコミットする。`.gitignore` しない。(2) で恒久インフラになるため。
    置き場所はリポジトリ直下の `compose.yaml`（`docker compose up -d` がフラグ無しで通る）
  - root パスワードは `.env`（gitignore）＋ `.env.example`。トークンと同じ「設定ファイルに書かない」方針に揃える。
    **現在の `.gitignore` に `.env` 行が無い**ため追記が要る
  - 疎通確認は手順書ではなくコマンド列にする。PAT 発行の自動化（`gitlab-rails runner`）は未検証、起動後に確認する
- 実測（`setup-local-gitlab` で確認済み）:
  - **ポート 8080 は使えない。** nginx は `external_url` のポートに追随するが、puma が既定で
    `127.0.0.1:8080` に bind するため衝突し、puma だけが EADDRINUSE で無限再起動する。
    コンテナは落ちないので `RestartCount` は 0、health も `starting` のまま 502 が返り続ける。
    採用値は 8929（`8929:8929`）。SSH は `2222:22`
  - `gitlab-rails runner` での PAT 発行は動く（`personal_access_tokens.build` → `set_token` → `save!`）
  - 常駐メモリは **2.42 GiB**（15.58 GiB 中 15.5%）。懸念していた 4GB を下回り常時起動は現実的
  - `grafana['enable']` は指定してはならない。omnibus から削除済みで、書くと reconfigure が
    `UnknownConfigOptionError` で失敗しコンテナがクラッシュループする
  - `/-/health` は `monitoring_whitelist` によりホストからは 404。疎通判定には `/users/sign_in` を使う
  - GitLab のバージョンは 19.3.1 (CE)、対象プロジェクトは `iepyon/ai-board`
