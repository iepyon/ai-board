---
id: loop-activity
title: AI ループの稼働状況をボードに出す
created: '2026-09-04T06:48:23.406Z'
startedAt: null
skipGates: []
change: null
branch: null
mr: null
---

## アイデア

ボードは「AI が今どのカードを触っているか」を一切示さない。`/loop` を回して監視するには必須。

- ループが `.ai-board/loop.json` を書く（tick / cardId / action / startedAt / note）
- ボードがそれを読んでトップバーに出し、対象カードに稼働バッジを付ける
- カードの frontmatter には持たせない。ループの状態はカードの属性ではないため
