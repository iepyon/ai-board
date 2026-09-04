---
id: gitlab-docker
title: Docker Compose で GitLab を立てて接続する
created: '2026-09-04T06:48:23.390Z'
explored: false
implStartedAt: null
change: null
branch: null
mr: null
stageOverride: null
---

## アイデア

AI-PR / AI-PR 修正済みの 2 列は GitLab の MR 状態から導出しているが、繋ぐ先が無いため常に空のままになっている。ローカルに GitLab を立てて開通させる。

## 探索メモ

- ai-board 側の実装はスタブサーバで全ステージ遷移まで検証済み。必要なのは url / projectId / トークンの 3 つだけ
- 使う API は 4 本のみ（MR 取得 / branch 解決 / notes / commits）。GitLab 側に特別な設定は要らない
- `gitlab/gitlab-ce` は起動に数分かかり、メモリも 4GB 前後を要求する。開発機で常時上げるのは重い
- トークンは `AI_BOARD_GITLAB_TOKEN` 環境変数から読む。設定ファイルには書かない
- 決めること: compose の置き場所、初期 root パスワードの渡し方、疎通確認の手順
