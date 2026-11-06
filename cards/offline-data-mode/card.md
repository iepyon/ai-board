---
id: offline-data-mode
title: ユーザは、GitHub に届かない研修の環境でも、カードと判断を手元の commit だけで書き込みたい
created: '2026-11-06T09:36:42.982Z'
skipGates: []
branch: null
mr: null
---

## アイデア

研修用に、データ用ブランチを fetch も push もせず、手元の commit だけで読み書きする「手元モード」を設定で選べるようにする。

- **設定で切り替える。** 手元モードでは `origin` に触れず、書き込みはロック → 手元の `HEAD` を基に検査 → commit で終える。読み出しも fetch せず、手元の内容で読む
- **今の形は残す。** 既定は今のまま（書き込みのたびに fetch と push）。普段の開発でクラウドのセッションやスマホから回す使い方は変えない
- **既にある仕組みを使う。** `origin` の無いデータのリポジトリでは、今も fetch と push を飛ばして commit だけする（`src/infrastructure/data-store.ts` の `no-origin`）。これを、`origin` のあるワークツリーでも設定から選べるようにする
- **後から GitHub に上げる口は、要るときに足す。** 明示の操作（例えば `ai-board data push`）で上げ、手元と `origin` が分かれていたら自動では混ぜずに止める

## 背景

研修はオフライン（GitHub に届かない環境）を前提に回せるようにしたい。
今の CLI は、書き込みの前の fetch に失敗すると書き込みを止める（`DataStoreFetchFailed`）。そのため、GitHub に届かないと、カードの起票・本文・提出・保留も、人の判断も、ループの 1 手の記録も、すべて失敗する。
fetch と push を外して commit だけにしても、読み書きの頭で手元を `origin/ai-board/data` に `reset --hard` で戻すので、次のコマンドで書いたものが消える。
研修は 1 台の Mac で完結し、同じ Mac の中のワークツリーはどれも同じ `.ai-board/data/` とロック（`data.lock`）を使うので、push が担っている「ほかの環境に渡す」「同時に書いたときに 1 つだけ通す」は要らない。

## 探索メモ

- 2026-11-06 の調べ。書き込みは `transact`（ロック → `sync`（fetch → `reset --hard origin/ai-board/data`）→ 書く → commit → push、拒否されたら最大 3 回やり直す）。読み出しも `refresh` で同じ `sync` を通る
- `no-origin` のときの `sync` は `discardTo('HEAD')` で手元の `HEAD` に揃える（`data-store.ts` の :379〜382）。手元モードはこの道に乗せられる見込み
- 計画で決めること
  - 設定の置き場所（`config.yaml` か環境変数か）。`config.yaml` はデータ用ブランチの根から読むので、読む前に決まっている必要がある
  - 手元モードで `status` / `decide` が GitHub に問い合わせるか。研修では `github:` を書かない運用で足りるか
  - 手元モードの間の commit を、後で `origin` に上げる口を今回入れるか
- ADR 0010（カードはデータ用ブランチに置き、書き込みのたびに push する）に、研修用の手元モードを書き足す
- `offline-snapshot-view`・`branch-plan-review` と合わせて、オフラインでもアイデアからマージ済みまでをボードに出せるようにする
