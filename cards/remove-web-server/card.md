---
id: remove-web-server
title: ユーザは、画面とサーバをいったん外し、ボードを CLI とチャットとダッシュボードだけで扱いたい
created: '2026-11-05T14:49:28.254Z'
skipGates: []
branch: remove-web-server
pr: 86
---

## アイデア

React の画面（`src/web/`）と、画面のためにあるサーバ（HTTP API・SSE・ファイル監視・データ用ブランチの取り直し・GitHub のポーラー）を外す。
ボードは `ai-board` の CLI（`status` / `card` / `decide` / `loop` / `pr`）と、チャット（`board-loop` / `board-decide`）と、`status --html` のダッシュボードだけで扱う。
画面は後でゼロから作り直す前提で、今は考えることを減らす。

## 背景

2026-11-05、GitHub API の上限対策（`forge-poll-budget`）で、サーバのポーリングをどう減らすかを話していた。
画面を表示に徹しさせる案から進んで、画面そのものを外せば、ポーリング・控えの食い違い・`src/shared/` を両方でビルドする制約などを考えずに済むと分かった。
判断は既にチャットから `ai-board decide` で書け（ADR 0007）、ボードはダッシュボード（ADR 0015）で見られる。
`idea-abort` でも、手間の半分は画面側だった。

## 論点

- **サーバが今書いているものの移し先。** PR 番号の書き戻しとマージ済みの PR の控えを、`status` 側で確実に書くか
- **CLI の入口。** `ai-board`（引数なし）でサーバを起動している入口と、`server.json` を読む箇所をどうするか
- **消す範囲。** `src/web/`、`src/server.ts`、controller とエラーのマッピング、`sse.ts` / `watch.ts` / `data-refresher.ts`、ポーラーの `start()`、Vite・React の依存、`dev:web`、e2e の supertest
- **残す純関数。** `src/shared/dashboard-sections.ts` などは `status` / `decide` / ダッシュボードが使うので残る。使われなくなるものだけ消す
- **ドキュメントと ADR。** README の画面の説明、`docs/architecture.md` の画面・API・SSE の節、`CLAUDE.md`（「ローカル Web ダッシュボード」、書き込み境界の表の「ai-board サーバ」の行、`127.0.0.1:5673`）を直し、画面とサーバをやめた理由を ADR に残す。画面に触れている ADR（0015 など）も今の形に直す

## 探索メモ

- 人と決めた（2026-11-05）: 画面とサーバをいったん消す。後でゼロから作り直す
- 消す前に画面を使わずに回して困る操作を確かめる段は、取らない（人の判断）
- `forge-poll-budget` は、サーバのポーリングが無くなると狙いの大半が無くなる。扱いは人が決める
