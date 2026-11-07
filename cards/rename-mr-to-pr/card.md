---
id: rename-mr-to-pr
title: 'ユーザは、GitHub の PR を MR !n ではなく PR #n として読みたい'
created: '2026-10-23T06:19:18.423Z'
skipGates: []
branch: rename-mr-to-pr
pr: 32
---

## アイデア

GitLab 連携を廃止したあとも残っている、GitLab 時代の名前と古い説明を、今の作りに揃える。

- **画面に出る文言。** ステージの理由が `MR !28 がオープン` / `MR !28 がマージ済み` と GitLab の書き方になっている。
  同じ画面で `計画の PR #28（Draft）` とも出ており、食い違っている。`PR #28` に揃える（`stage-resolver.ts` の `reason`）
- **コードの名前。** `MrState` / `mrState` / `MergeRequestIid` / `iid` / `fetchByIid` / `MrStateProvider` などを、PR の名前に寄せるか決める
- **古い説明。** 作りが変わったのに直っていないコメントを直す
  - `card.repository.ts`: 「実装は `.ai-board/cards/` 配下の Markdown ファイル」（今は SQLite）
  - `stage-resolver.ts` / `web/types.ts` / `board-card.ts`: 「人が直接ドラッグで動かせるステージ」「ドラッグ不可」（列をまたぐドラッグは廃止し、今は「着手」「着手を戻す」のボタン）

## 背景

GitLab 連携は廃止し、取得先は GitHub の PR だけになった（CLAUDE.md「レビュー要求の取得先」）。
しかし、型と変数の名前、画面の文言、コメントには MR / iid / `!n` が残っている。
2026-10-23 に `ai-board status` を作ったとき、出力に `MR !30 がオープン` と出て、PR #30 のことだと読み替える必要があった。

GitLab の MR !1 と GitHub の PR #1 を取り違えて、リンクだけが別の PR を指す事故を防ぐため、DB のマイグレーション（v2・v3）で `forge` 列を落とした経緯がある。
名前に MR が残っていると、まだ 2 つの取得先を扱っているように読めてしまう。

## 論点

- **どこまで改名するか。** 画面の文言とコメントだけにするか、型・変数・関数名まで変えるか。後者は差分が大きい（テスト以外で 15 ファイルほど）
- **DB の列名と API の項目名。** カードの `mr` 列と、`GET /api/board` の `mr` / `mrState` は外から見える名前である。
  変えるならマイグレーションと画面の同時の変更が要る。変えずに、コードの中の名前だけを揃える手もある
- **「レビュー要求」という言い方。** CLAUDE.md は取得先を「レビュー要求」と抽象化して書いている。PR に寄せるか、抽象名を残すか
