---
id: board-status-command
title: サーバ不要でボードを読む status サブコマンドを足す
created: '2026-09-04T06:48:23.405Z'
explored: false
implStartedAt: null
change: null
branch: null
mr: null
stageOverride: null
---

## アイデア

AI ループがボードを読むために HTTP サーバの起動を前提にすると、ループがサーバの生死に依存してしまう。

`ai-board status [--json]` を足し、`getBoardQuery` を再利用して標準出力に吐く。ロジックは足さない。
