---
id: board-loop-skill
title: AI ループの中核スキルを作る
created: '2026-09-04T06:48:23.403Z'
startedAt: null
skipGates: []
change: null
branch: null
mr: null
---

## アイデア

ボードを 1 周進める Claude Code スキル。`/loop 15m /board-loop` で間隔運転する。

1 周で行うのは優先順に 1 つだけ。進める先はいずれも AI の列で、★ の列では止まる。

1. 実装中 / 検証中のカードがあれば → 実装を 1 ステップ進めてコミット
2. 計画提案中のカードがあれば → openspec change を起票し `## レビュー` に plan 提出を書く
3. 探索中のカードがあれば → 調べて `## 探索メモ` を書き、`## レビュー` に explore 提出を書く
4. どれも無ければ → 人待ちを報告して終わる

openspec の書き方は自前で持たず、既にある `/opsx:propose` / `/opsx:apply` / `/opsx:archive` に委譲する。

**ハードルール**（人の承認を代行しない）

- `startedAt` を自分で打たない。着手の指示は人が出す
- `## レビュー` に書いてよいのは 提出 / 再提出 だけ。承認 / 否決 / 中止 は人が書く
- `skipGates` を自分で足さない
- 探索レビュー / 計画レビュー / PR中 のカードに触らない
- 品質ゲートを通らないままコミットしない
