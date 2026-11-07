---
id: forge-card-error
title: ユーザは、1 枚の PR が GitHub から引けないだけで、ボードとループ全体を止めてほしくない
created: '2026-11-03T02:32:40.777Z'
skipGates: []
branch: forge-card-error
pr: 83
---

## アイデア

GitHub への問い合わせが 1 枚のカードの PR だけで失敗したとき、ボード全体を「接続エラー」にせず、そのカードだけを止める。

- **止める範囲をカードに絞る。** 引けなかったカードは「PR の状態を引けない」として `waiting`（または専用の止まり）に出し、ループはそのカードを飛ばす。ほかのカードは今までどおり導出し、`next` を出す
- **全体のエラーは全体の失敗に限る。** `gh` の未ログイン・ネットワークの断・上限など、どのカードも引けないときだけ `forge.status` を `error` にする
- **何が失敗したかを見せる。** 今の `message` は「gh の終了コード 1 で失敗した」だけで、どのカードのどの問い合わせかが分からない。カード ID・PR 番号・HTTP のステータスと本文の 1 行を出す

## 背景

2026-11-03、loop-permissions の AI レビューが終わった直後から、`gh api repos/iepyon/ai-board/pulls/68` が GitHub から HTTP 422「The request could not be processed because too many files changed」を返し続けた。
同じ PR の `pulls/68/files`（10 件）・`compare/main...loop-permissions`・PR の一覧は引け、閉じた PR（#65・#66）も 1 件ずつ引けた。変更は 10 ファイルで、GitHub の側の不具合か一時的な状態と見ている（応答は `Server: github.com`）。

`ForgePoller.refresh`（`src/infrastructure/forge-poller.ts`）は、カードごとの失敗を `firstError` に拾い、1 件でもあれば接続の状態をまるごと `error` にする。
`status` は `forge.status` が `connected` でないと `next` を `null` にする（`src/board/cli/status-cli.ts`）。
そのため、PR 1 枚の失敗で、ほかのカードも含めてループ全体が止まった。エラーの文言も「gh の終了コード 1 で失敗した」だけで、原因の PR を突き止めるのに手で `gh api` を叩き直した。

`next` を止めているのは、PR が引けないと計画レビュー / PR中 のカードが手前の AI の列に落ちて見え、AI が人の番のカードに手を出すおそれがあるためである。この安全側の考えは保つ。

## 論点

- **引けなかったカードの見せ方。** 前回引けた状態を使い回すか（`forge-poll-budget` の使い回しとつながる）、「不明」として AI の列に落とさず止めるか。手前の AI の列に落とすことだけは避ける
- **全体の失敗との見分け。** 全カードが失敗したら全体のエラー、一部なら個別、で足りるか。カードが 1 枚しか無いときは見分けられない
- **止まりの種類。** `waiting` の止まりに「PR を引けない」を足すか。人が判断のボタンで解くものではない（時間が経てば直る）ので、既存の止まりとは性質が違う
- **ループの報告。** 監視役が人に何を伝えるか（どのカードのどの PR が、どんな応答で失敗したか）
