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

1 周で行うのは優先順に 1 つだけ。

1. 実装中のカードがあれば → 実装を 1 ステップ進めてコミット
2. 探索済みのカードがあれば → openspec change を作る
3. どちらも無ければ → 人待ちを報告して終わる

openspec の書き方は自前で持たず、既にある `/opsx:propose` / `/opsx:apply` / `/opsx:archive` に委譲する。

**ハードルール**（人の承認を代行しない）

- カードを実装中へ動かさない
- 提案済み / AI-PR 系のカードに触らない
- 品質ゲートを通らないままコミットしない
