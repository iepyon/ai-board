---
id: archive-sync-gap
title: マージ済みと archive 済みを見分けられるようにする
created: '2026-09-11T01:52:44.055Z'
startedAt: null
skipGates: []
change: null
branch: null
mr: null
---

## アイデア

ボードは archive 済みかどうかを区別できない。`merged` の条件が
「archive に存在する **または** MR が merged」の OR になっているため、
両方が同じ列に落ちる。

```
| 1 | merged | archive に存在、または MR が merged |
```

結果、**「マージは済んだが delta spec が `openspec/specs/` へ同期されていない」
カードが完了列に紛れて見分けが付かない。**

`openspec/specs/` はこれから書く全部の change が差分の土台にするファイルなので、
同期漏れが静かに積み上がると後から効いてくる。実際 `board-lanes` は MR !4 の
マージで `merged` に入ったが、その時点で archive はされておらず
`openspec/specs/` は `.gitkeep` だけだった。

## 検討する方向

- `merged` を 2 段に割る（`merged` → `archived`）。10 列目が増える
- 列は増やさず、MR は merged だが archive されていないカードにバッジを出す
- archive を AI の自走工程として扱い、マージ後に自動で走らせる

列を増やすかどうかは、archive が「人が判断すること」か「AI が淡々とやること」かで決まる。
delta spec の本体へのマージは内容の判断を含むので、レビューを挟む余地はある。
一方で tasks が全完了して MR もマージ済みなら、残っているのは機械的な移動だけとも言える。

## 前提

- archive は git の操作ではなく `openspec/specs/` を書き換える操作。差分が生まれる
- `openspec-archive-change` スキルのステップ 4（`openspec-sync-specs`）が本体で、
  ステップ 5 のディレクトリ移動はその後始末
- 既知の未追従（CLAUDE.md）: change 名が `YYYY-MM-DD-` で始まる場合、
  openspec 1.12.0 は接頭辞を重ねないため、日付を剥がす前提の完了判定が外れる
