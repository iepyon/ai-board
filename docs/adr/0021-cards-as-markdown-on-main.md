# 21. 置き場所は git の main の Markdown を既定にし、Artifact の DB と設定で選べるようにする。計画はカードのディレクトリに置く

- 状態: 提案
- 日付: 2026-11-22

## 背景

カードの正本は Artifact の DB に置いていた（[20](0020-cards-in-artifact-db.md)）。しかし使う場によっては claude.ai が使えず、DB に届かない。
そうした場では 3 人で 1 つのボードを共有し、各自のローカル PC で動かす。GitHub は使える。ボードはブラウザで見るだけで、判断はチャットで頼む。
一方で、claude.ai を使える場で Artifact の DB を使い続ける人もいる。

## 決定

- **置き場所の種類を `.ai-board/config.yaml` の `store.kind`（`git` / `artifact`）で選び、既定を `git` にする。** 種類で変わるのは `DocumentStore` の実装と、Claude が CLI の前後に取り込み・送り出しをするかだけにする。
- **git の置き場所: main の `.ai-board/cards/<id>/card.md`（frontmatter と本文）と `log/`（判断 1 件 1 ファイル）、`.ai-board/order.yaml` に置く。** CLI は fetch した main を読み、その上にコミットを作って push する。push が拒まれたら取り直してやり直す。
- **仕様つきの計画は、どちらの置き場所でも `.ai-board/cards/<id>/plan.md` に置き、カードのブランチから PR でマージする。** 紐付けは名前（ディレクトリ名）で行う。カードのブランチでは置き場所のファイルを変えない（push の前に検査で止める）。
- **main に `plan.md` があればマージ済みとする。** `archive/` へ移す手順はなくす。
- **仕様は `plan.md` に差分として書き、`docs/specs/` は同じ PR で書き直し続ける。**
- main の計画は作業ツリーではなく git の参照から読む。今の置き方（`plans/<id>.md`・`plans/archive/<id>.md`）も互換として読み続ける。
- ステージは今までどおり導出し、形の版は置き場所の種類で変えない。ただし「計画ファイルがあるだけで計画レビュー」の保険（[1](0001-derive-stage.md)）は、GitHub が未設定のボードのブランチの計画と互換の `plans/<id>.md` だけに縮む。

## 結果

- git の置き場所では、写し・送る箱・送り出しが要らず、人のいない `/loop` からも書ける。同期・楽観ロック・判断の履歴を git が兼ねる。
- git の置き場所では、main に書き込みのコミットが頻繁に入り、main に直接 push できることが前提になる。エディタでの直接の書き換えは、Claude の `Edit` の deny と push の前の検査で補う。
- git の置き場所では、PR の控えとループの記録を各 PC に置き、共有しない。ブラウザで見るには、静的な HTML の出口が要る（[19](0019-board-view-artifact.md) を書き直す）。
- 置き場所の実装・手順書の取り込みと送り出し・hook を、2 つの種類の分だけ保守する。使っている最中のボードを種類をまたいで移す手順は無い。
- 互換の読み方のコードを、artifact のボードの今のカードがマージされるまで持ち続ける。採用したら [1](0001-derive-stage.md)・[4](0004-plans-in-draft-pr.md)・[20](0020-cards-in-artifact-db.md) を今の形に書き直す。

## 退けた案

- **artifact の置き場所を消して git に一本化する** — claude.ai を使える場で artifact を使う人がいる。
- **カードを GitHub Issues に置く** — 改訂が JSON のコメントになって読みにくく、今の形（seed・計画の Markdown）から遠い。
- **SQLite に置く** — 各自の PC に置くと共有できず、1 台に置いて配ると常駐サーバと認証が要る（[17](0017-remove-web-and-server.md) で外したもの）。
- **ローカルの MCP サーバがボードの HTML を返す** — 描画されるのは MCP Apps に対応したチャットの中で、ブラウザのタブではない。3 人の共有の問題も解けない。

根拠: 置き場所の代替案を話したチャットと、計画 `cards-as-markdown` の差し戻し（2026-11-22）、PR #116
