---
id: pr-checks-short-sha
title: ユーザは、ai-board pr checks の --sha に短いハッシュを渡しても、そのコミットのチェックを読みたい
created: '2026-11-06T04:21:16.114Z'
skipGates: []
branch: pr-checks-short-sha
mr: null
---

## 背景

`ai-board pr checks <n> --sha <sha>` は、`--sha` に 7〜40 桁の 16 進を受け付ける（`src/board/cli/pr-cli.ts` の `parseChecksOptions`）。
ところが、見るコミットが PR の head かどうかは、PR の `head.sha`（完全なハッシュ）との `!==` で比べている（`src/board/services/github-client.ts` の `checks`）。
そのため短いハッシュを渡すと、head が同じコミットでも「まだこのコミットになっていない」と読まれ、チェックを引かずに `pending` を返す。
`--wait` を付けると、上限（既定 900 秒）まで待ってから `pending`（終了コード 2）で終わる。
ループは `git rev-parse HEAD` の完全なハッシュを渡すので当たらないが、人が手で短いハッシュを打つと当たる。
2026-11-06 に PR #88 の動作確認で `--sha 2db0a1f` を渡して実際に当たった（出力は「PR の head はまだ 2db0a1f で、このコミットになっていません」）。

## アイデア

短いハッシュを渡しても、同じコミットなら head と一致したと読むようにする。
例えば、`--sha` の値を `head.sha` の先頭と比べる。または、受け付ける値を完全なハッシュ（40 桁）だけにし、短いハッシュは使い方の誤りとして拒む。
どちらにするかは計画で決める。直す前に、短いハッシュで落ちるテストを足す。
