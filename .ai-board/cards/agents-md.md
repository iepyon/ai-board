---
id: agents-md
title: AGENTS.md / CLAUDE.md でリポジトリの規約を明文化する
created: '2026-09-04T06:48:23.409Z'
explored: false
implStartedAt: null
change: null
branch: null
mr: null
stageOverride: null
---

## アイデア

AI がこのリポジトリの規約を知る手段が無い。ループを回すなら必須。

書くこと。

- コマンド一覧、レイヤー構成、`Result<T,E>` / discriminated union / Composition Root の規約
- **書き込み境界**: `openspec/` は AI が書く / `.ai-board/` はボードが書く
- ステージ制限の意味（人の列と AI の列、AI がやってはいけないこと）
- ESM で import に `.js` を書く、パスエイリアスを使わない理由
- openspec v1.3.1 の実装に合わせた判定ロジック（archive の日付プレフィックスなど）
- 日本語 Conventional Commits
