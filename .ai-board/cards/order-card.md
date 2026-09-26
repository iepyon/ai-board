---
id: order-card
title: カードの並び替えができる
created: '2026-09-10T23:57:51.124Z'
startedAt: null
skipGates: []
branch: order-card
mr: 6
forge: github
---

## レビュー

### 2026-09-26T01:39:49.000Z plan 提出

計画を `.ai-board/plans/order-card.md` に作成。判断待ちの点は 3 つ。
順序を別ファイルではなく frontmatter の `rank`（数値、無ければ `created` のエポックミリ秒）で持つこと、
並び順を列ごとではなく全カードで 1 本にすること、`rank` を人の領分としてエージェントに書かせないこと。
同じ内容の `card-ordering` カードが別にあるので、承認するならそちらは中止してよい。

### 2026-09-26T01:42:49.895Z plan 承認
