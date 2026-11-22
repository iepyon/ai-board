---
id: cards-as-markdown
title: 開発者は、claude.ai を使えない場でも、3 人で 1 つのボードを main の Markdown として共有したい
---

## アイデア

カードの正本を Artifact の DB から、main の `.ai-board/cards/<id>/card.md` に移す。仕様つきの計画は同じディレクトリの `plan.md` に置く。

- `card.md` は main に直接 push し、`plan.md` はカードのブランチに載せて PR でマージする
- main に `plan.md` があればマージ済みとし、`archive/` へ移す手順をなくす
- 仕様は `plan.md` に差分として書き、`docs/specs/` は同じ PR で書き直し続ける
- ステージは今までどおり導出する（ADR 0001 は変えない）

判断の内容は ADR 0021（提案）にある。

## 背景

使う場では claude.ai が使えず、Artifact の DB に届かないと分かった。使うのは 3 人で、1 つのボードを共有し、各自のローカル PC で動かす。GitHub は使える。
スマホや、PC を閉じたままの操作は要らない。ボードはブラウザで見るだけで、判断はこれまでどおりチャットで頼む。

## 論点

- 写し・送る箱・`board-store` のスキル・`ArtifactData` の hook をどこまで消すか
- git への書き込み（pull・commit・push、push が拒まれたときのやり直し）を CLI のどこに置くか
- マージ済みの PR の控えとループの記録の置き場所
- ブラウザで見るための出口（`board-view` の Artifact をやめた後）

## 探索メモ

- 2026-11-22 のチャットで、GitHub Issues・SQLite・ローカルの MCP サーバが HTML を返す案と比べて、この案に決めた（ADR 0021 の退けた案）
- 前提: main に直接 push できる（ブランチ保護で PR 必須になっていない）
