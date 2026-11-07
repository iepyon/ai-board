---
id: loop-dummy
title: ユーザは board-loop が計画の Draft PR を出して止まることを、ダミーのカードで確かめたい
created: '2026-10-23T05:49:05.376Z'
skipGates: []
branch: loop-dummy
pr: 29
---

## アイデア

`board-loop` スキルの動作確認のためのダミー。マージしない。

README の末尾に、`ai-board status` の出力例を 1 つ足す。

## 背景

`/board-loop` を手で 1 回呼び、計画を書いて Draft の PR を出し、`plan 提出` を書いたところで止まることを確かめたい。
確認が済んだら、PR は閉じてブランチを消し、カードは中止にする。
