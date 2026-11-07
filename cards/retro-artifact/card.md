---
id: retro-artifact
title: ユーザは、期間を指定して、工程ごとの時間とボトルネックを Artifact の 1 枚で振り返りたい
created: '2026-11-06T08:49:49.033Z'
skipGates: []
branch: null
pr: null
---

## アイデア

「振り返りを見せて」と頼むと、指定した期間のカードについて、今のデータから出せる数字を 1 枚の Artifact のページにまとめて出す。

- **カードごとのリードタイム。** 起票（`created`）・着手（`startedAt`）・計画の提出と承認（`reviews` の時刻）・PR の Ready（`prState.readyAt`）・マージ（`prState.mergedAt`）の時刻から、着手からマージまでと、その間の区切りごとの時間を出す。中央値で並べ、長くかかったカードは上位を名指しする
- **差し戻しの率。** 計画の提出・再提出に対する差し戻しの数（`reviews` の plan のエントリ）を出す
- **ループの手。** 期間内の 1 手の記録（`loopSteps` / データ用ブランチの `loop/`）を、手と段（`plan` / `implement` の `task`・`review`・`close` / `ready` / `revise-plan` / `revise-impl`）ごとに件数・結果（`advanced` / `stopped` / `held` / `failed` / `unknown`）・時間（`finishedAt - startedAt`）で並べる
- **期間を指定できる。** 研修の 1 周ごとや週ごとに出す
- 本体（`src/`）には手を入れず、スキルが `status --json` を読む

## 背景

ADR 0017 で `status --html` のダッシュボードを外し、工程ごとの滞在時間の集計は出なくなった。
続けて 2026-11-07 のコミット 44e6dbc で、読み手の無くなったカードの区間（`timeline`）の導出と、1 手の記録の時間・トークン・手順書の版（`durationMs` / `tokens` / `harness`）も外した（ADR 0014）。
そのため、このカードの最初の案（区間の種類ごとの中央値、AI の区間の待ちと作業の割合）はそのままでは出せない。
一方で、カードの判断の時刻・PR の Ready とマージの時刻・1 手の開始と終了の時刻は今も `status --json` から読めるので、これらだけでリードタイムと止まりを振り返る。
研修では、回した結果を時間で振り返ることが学びの中心になるので、頼めば 1 枚で振り返れるページがほしい。

## 論点

- **区切り方。** `timeline` が無いので、どの時刻とどの時刻の差を「工程」と呼ぶかを計画で決める（例: 着手→計画の提出、提出→承認、承認→Ready、Ready→マージ）。差し戻しや再提出を挟んだカードの数え方も決める
- **待ちと作業。** 1 手の開始・終了から作業の時間は出せる。手と手の間を「ループに拾われるのを待っていた時間」とみなしてよいか（人の判断待ちや、ループが止まっていた時間と区別できるか）
- **数字のぶれ。** 毎回 Claude に集計させると、同じデータでも数字や丸め方がぶれる。集計を手順書に式として書くか、ぶれが困ったら本体に純関数として戻すか（本体に戻すなら ADR 0014・0017 との関係を書く）
- **時刻の無いカード。** 2026-11-02 より前のカードには 1 手の記録が無い。PR を経ずにマージ済みになったカードには `mergedAt` が無い

## 探索メモ

- 2026-11-07 に、`timeline` と 1 手の時間・トークン・版を外した今のリポジトリに合わせて本文を書き直した。区間の種類ごとの中央値は出せないので外した
- 2026-11-07 の時点で、1 手の記録は 152 手（`advanced` 140・`stopped` 9・`held` 1・`failed` 1・`unknown` 1）
- `status --json` の `cards[]` の項目: `created` / `startedAt` / `reviews`（`at` / `gate` / `kind` / `reason`）/ `prState`（`readyAt` / `mergedAt` / `convertedToDraftAt` など）/ `loopSteps`（`action` / `step` / `startedAt` / `finishedAt` / `result`）
- 動作確認のゲート（`verify`）は廃止され、古いカードの本文に残る `verify` のエントリは `reviews` に出ない（`src/cards/models/review.ts` の `RETIRED_REVIEW_GATES`）。PR中 の差し戻しは今は PR のコメントで返す（ADR 0016）
- 時間は夜間も数える実時間。消した集計（`computeBoardMetrics`、`median`）は、コミット 981587f の親の `src/shared/board-metrics.ts` にある
- 理由を読む振り返りは `retro-stop-reasons` に分ける
