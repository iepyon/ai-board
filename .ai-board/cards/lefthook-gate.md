---
id: lefthook-gate
title: lefthook の pre-commit で品質ゲートをかける
created: '2026-09-04T06:48:23.410Z'
startedAt: null
skipGates: []
branch: null
mr: null
---

## アイデア

AI のコミットが壊れたまま進まないようにする最後の砦。

`prettier --check` / `eslint` / `tsc --noEmit`（サーバ + web）/ `vitest run` を並列実行する。
