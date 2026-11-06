---
id: forge-unset-decide
title: ユーザは、GitHub を設定していない研修のボードでも、判断を書いてループを進めたい
created: '2026-11-06T12:35:43.307Z'
skipGates: []
branch: null
mr: null
---

## アイデア

GitHub を設定していない（`config.yaml` に `github:` が無い）ボードでも、人の判断（着手 / 着手を戻す / 承認 / 差し戻し / 中止）を書け、ループの次の一手が出るようにする。

- **未設定と届かないを分ける。** GitHub が「未設定」（`disabled`）なら PR はそもそも無いので、判断の検査と次の一手を通す。「設定してあって届かない」（`error`）なら、今どおり拒み、次の一手も出さない
- **導出の核は変えない。** `stage-resolver.ts` に条件は足さない。変えるのは判断の検査（`decision-guards.ts`）と次の一手の出し方（`get-status.query.ts`）の入口だけにする

## 背景

研修はオフライン（GitHub に届かない環境）を前提に回せるようにしたい。
今は GitHub が「接続済み」でないと、`decide` の判断を `ForgeUnavailable` で拒み（`src/board/services/decision-guards.ts` :33・:61）、`status` の `next` を null にする（`src/board/usecases/queries/get-status.query.ts` :56）。
この守りは、PR の状態が引けないと計画レビューや PR中 のカードが手前の列に落ちて見え、判断を取り違えるのを防ぐためにある（`src/board/cli/decide-cli.ts` :319）。
ただ、`github:` を書かない（未設定）ときも同じに扱うので、研修で GitHub を外すと着手も承認もできず、ループも動かない。
未設定なら PR は無く、手前に落ちて見える心配も無い。

## 探索メモ

- 2026-11-06、`offline-data-mode` の調べで見つけ、人の答えで別のカードにした。`offline-data-mode` は書き込みの手元モードに絞る
- `offline-snapshot-view` は「ループと判断の検査は今のまま（つながっていないときは次の一手を出さない）」としている。届かない（`error`）ときの扱いはそれと揃え、このカードは未設定（`disabled`）だけを扱う
- 計画で決めること
  - 未設定のボードで、計画の手（Draft の PR を出す）をループがどう進めるか。`branch-plan-review` とのかみ合わせ
  - 途中で `github:` を足したり外したりしたときに、既に PR を持つカードが手前の列に落ちて見えないか（`mr` を持つカードがあれば拒む、など）
  - ADR 0007（board-decide）・ADR 0003（GitHub を gh に委ねる）への書き足し
