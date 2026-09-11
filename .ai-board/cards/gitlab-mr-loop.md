---
id: gitlab-mr-loop
title: ai-board 自身の開発を GitLab の MR で回す
created: '2026-09-04T07:32:00.000Z'
startedAt: null
skipGates: []
change: null
branch: null
mr: null
---

## アイデア

`gitlab-docker` でローカル GitLab の疎通までは通す。その先、ai-board 自身のリポジトリを
その GitLab に push し、change の実装を実際にブランチと MR で回して AI-PR / AI-PR 修正済みの
2 列を実データで埋めるところまでを扱う。

## 探索メモ

- ai-board は自分自身のチケットを自分で管理している（283b606）。よって AI-PR 列に並ぶのは
  ai-board 自身の MR になる。列を埋めるには「読む接続」だけでなく「置く接続」が要る
- **現在 `git remote -v` は空**。push 先が無いので、GitLab を立てただけでは MR は 1 本も生まれない
- カードの `branch` から `fetchByBranch()` が MR を自動解決する。運用の起点はカードに branch を書くこと
- 決めること:
  - remote を HTTP（PAT 埋め込み）にするか SSH にするか。HTTP だと `.git/config` にトークンが残る
  - GitLab を常時起動しない場合の扱い。落ちている間 AI-PR 列は空になり、接続状態は error を表示する
  - AI エージェントが MR を作る手順（glab CLI / API 直叩き / 手動）
- 依存: `gitlab-docker` の疎通が先。compose と PAT 発行はそちらの成果物を再利用する

## レビュー

### 2026-09-11T01:32:52.165Z explore 承認
