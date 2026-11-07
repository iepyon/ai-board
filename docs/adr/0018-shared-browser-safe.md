# 18. `src/shared/` にはブラウザでも動く値と型だけを置き、計算はサーバ側のコンテキストに置く

- 状態: 採用
- 日付: 2026-11-07

## 背景

画面とサーバは [17](0017-remove-web-and-server.md) でいったん外したが、後で戻し、CLI と HTTP の両方から同じ usecase につなぐ予定である。
`src/shared/` には、画面のために置いた区画・出せる判断・ループの要約などの純関数が、board からしか使われないまま残っていた。
「`shared` はコンテキストの型を引かない」という決まりのため、`ReviewGate` の `'plan'` や `effectiveRank` を書き写す回避策が増え、`node:fs` を使う設定の読み込みも同じ場所にあった。

## 決定

- **`src/shared/` には、ブラウザでも動き、2 つ以上のコンテキスト（board / cards / infrastructure / 戻す画面）が実行時の値として使うものだけを置く。** 今は `Result`、`Stage` と ID の型とスキーマ、`DIVIDER_ID`、列の見出しのラベル。
- **区画・出せる判断・動きなし・アイデアの区切りなどの計算は、サーバ側のコンテキスト（`src/board/`）に置く。** 画面を戻すときは、サーバが計算して `StatusReport` で返し、画面は表示だけをする。
- 型だけを使う側は、置き場所を問わず `import type` で引く（ビルドで消える）。型の共有は `shared` に置く理由にしない。
- Node の API を使うもの（設定の読み込み・ワークツリーの解決）は `src/infrastructure/` に置く。
- **eslint の `no-restricted-imports` で、`src/shared/`（テストを除く）から Node の API・`board/`・`cards/`・`infrastructure/` を import できなくする。**

## 結果

- board の純関数が `ReviewGate`・`CardHold`・`effectiveRank` を直接引けるようになり、書き写しが消えた。
- 画面を戻すときに、`shared` を画面とサーバの両方でビルドする制約が、ブラウザで動く小さなファイルだけに限られる。
- 画面で応答を待たずに計算したいもの（並べ替えをすぐ画面に映すなど）が出たら、その純関数だけを決まりに照らして `shared` に置く。画面の要件が見えてから決める。
- 画面と共有する API 専用の型を作るかは、サーバを戻すときに決める。今は `StatusCard` が内部のモデル（`BoardCard`）をそのまま出している。

## 退けた案

- **区画・出せる判断を `shared` に残し、画面でも計算する** — 17 が挙げた「`shared/` を両方でビルドする制約」が戻る。
- **`shared` をそのままにして eslint だけ足す** — 書き写しが残り、`node:fs` を使う設定の読み込みが決まりに反する。
- **`tsconfig` を分けて `shared` だけ Node の型を外す** — 設定が二重になり、`board/` への import は拒めない。

根拠: `.ai-board/plans/shared-browser-safe.md`、カード `shared-browser-safe` の `## 背景` と `## 探索メモ`、PR #101
