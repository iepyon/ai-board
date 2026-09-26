---
id: claude-hooks
title: Claude Code hooks で編集直後に品質を検出する
created: '2026-09-04T06:48:23.412Z'
startedAt: null
skipGates: []
branch: null
mr: null
---

## アイデア

AI の手元で壊れを即時に検出する。

| hook | 発火 | 動作 |
|---|---|---|
| prettier-format | PostToolUse: Edit\|Write | 編集ファイルを自動整形（block しない） |
| lint-guard | PostToolUse: Edit\|Write | ファイル単体を ESLint。違反で block |
| tsc-check | Stop | サーバ + web の型チェック。エラーで block |

シェルスクリプトは macOS / zsh 互換にする（GNU 固有フラグを使わない）。
