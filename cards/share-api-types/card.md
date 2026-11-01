---
id: share-api-types
title: AIエージェントは、API の応答に項目を足したとき、画面の型の写し忘れに型検査で気付きたい
created: '2026-10-23T06:19:18.191Z'
skipGates: []
branch: null
mr: null
---

## アイデア

画面（`src/web/`）が使う API の型を、サーバの型から導く。手で写した型をなくす。

- `GET /api/board` の応答の型（`Board` / `BoardCard` / `BoardCardMr` / `ForgeConnection` など）を、サーバと web の両方から読める場所に置く。
  候補は `src/shared/`（両方の tsconfig に入っている）か、web から `src/board/models/` を `import type` すること
- `HUMAN_STAGES` を 1 か所にする（今は `stage-resolver.ts` と `web/types.ts` の 2 か所にある）
- JSON にすると型が変わるもの（`CardId` などの Branded Type が素の string になる、`readonly` が外れる）の扱いを決める

## 背景

`src/web/types.ts` は「API レスポンスの型（サーバの BoardCard と対応）」として、`Stage` / `ReviewKind` / `GateState` / `BoardCard` / `BoardCardMr` / `ForgeConnection` / `Board` を手で写している。
サーバ側に項目を足しても、web 側に足し忘れると型検査では気付けず、画面で `undefined` になって初めて分かる。
`MrState` に `draft` を足したときも、`BoardCardMr` の 2 か所（サーバと web）を直す必要があった。

`STAGE_LABELS` は、`board-loop-skill` の実装のときに `src/shared/stage-labels.ts` へ移して共有した。同じ形で残りも揃えられる。

## 論点

- **web に zod を持ち込まない。** `src/shared/schemas/common.ts` は zod を import している。web は型しか要らないので、`import type` で済む形にするか、
  zod に依存しない型だけのファイルを分ける
- **応答の型を宣言するか、導くか。** サーバの `BoardCard` を JSON にした形を型で表す（Branded Type を外すユーティリティ型など）か、
  `src/shared/` に応答の型を宣言してサーバがそれを満たすようにするか
- **`Board` の `stages`。** 応答には `stages` があるが、サーバの `Board` 型には無い（コントローラで足している）。どちらに寄せるか
