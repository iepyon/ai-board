---
id: unset-impl-close
title: ユーザは、GitHub を設定していない研修のボードでも、承認した計画を実装からマージ済みまで進めたい
created: '2026-11-07T01:34:41.396Z'
skipGates: []
branch: null
mr: null
---

## アイデア

GitHub が未設定（`config.yaml` に `github:` が無い）のボードで、承認の後の実装の手を最後まで進め、PR の無いままマージ済みまで運べるようにする。

- 実装の手の節ごとの `git push` を、未設定のボードでは飛ばす（コミットだけ）
- 締めの段の `ai-board pr checks` / `pr edit` / `pr ready` の代わりに、動かした証拠をどこに書き、何をもって人の番（PR中 にあたるもの）とするかを決める
- 人がどうマージし、何をもってマージ済みとするか（メインのチェックアウトに計画の archive が入る、など）を決める

## 背景

研修はオフライン（GitHub に届かない環境）を前提に回せるようにしたい。
`forge-unset-decide` で未設定のボードでも判断と次の一手が出るようになり、`branch-plan-review` で計画レビューまでは立つ見込みになった。
ただ承認の後の実装の手は、節ごとの push と、締めの `pr checks` / `pr edit` / `pr ready` を前提にしているので、未設定のボードでは止まる。

## 探索メモ

- 2026-11-07、`branch-plan-review` の調べで見つけ、人の答えで別のカードにした
