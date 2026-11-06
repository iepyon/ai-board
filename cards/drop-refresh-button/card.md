---
id: drop-refresh-button
title: ユーザは、ダッシュボードの更新ボタンをやめ、更新はチャットで頼む形にそろえたい
created: '2026-11-06T11:11:11.615Z'
skipGates: []
branch: null
mr: null
---

## アイデア

ダッシュボード（`ai-board status --html`）の「更新」ボタンをやめ、更新はチャットで「ダッシュボードを更新して」と頼む形にそろえる。

## 背景

2026-11-06、公開したダッシュボードの「更新」ボタンを押すと、claude.ai が「Claude Code Remote — このコネクタを読み込めませんでした」と出し、更新できなかった。
ボタンは、見ている人のアカウントの `Claude Code Remote` コネクタの `send_message` で、公開したセッションに決まった 1 文を送る仕組み（ADR 0015）。
セッションから同じ文を自分に `send_message` すると届くので、セッション側ではなく、ページからコネクタを読み込めないことが原因である（Android のアプリから開いたページで起きた）。

## 論点

- `status --html` の `--session` と、ボタン・スクリプト・`REFRESH_MESSAGE` などを消すか
- `board-dashboard` のスキルから `get_session`・`capabilities`（`mcp`）・更新を頼むメッセージの扱いを消す
- ADR 0015 を書き直すか消すか

## 探索メモ

- 人と決めた（2026-11-06）: ボタンをやめ、チャットで頼む形にする
