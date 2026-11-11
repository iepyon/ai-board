---
id: message-presenters
title: AIエージェントは、人に読ませる文言を CLI の外に置き、CLI とサーバの両方から同じ 1 行を返したい
created: '2026-11-11T06:42:51.790Z'
skipGates: []
branch: null
pr: null
---

## アイデア

usecase が返すエラーや拒否のデータを、人に読ませる日本語の 1 行にする関数を、CLI のファイルから入口に依存しない場所（例: `src/board/presenters/`・`src/cards/presenters/`）へ移す。動きと文言は変えない。

- **移すもの。**
  - `src/board/cli/decide-cli.ts` の `describeRefusal` / `describeDecideError` / `describeChoices`（と、それが使う `forgeHoldNote` / `startedAtLabel`）
  - `src/board/cli/status-describe.ts` の `describeNext` / `describeForge` / `describeLoop` / `describeStuck`
  - `src/cards/cli/data-store-messages.ts` の `describeDataStoreError` / `describeOfflineRead`
  - `src/board/cli/pr-cli.ts` の `describePrError`
- **CLI に残すもの。** 引数の読み取り、使い方の文、終了コード、標準出力への書き出し（`formatStatus` のような端末向けの並べ方も含む）
- **向きを決める。** `cli/` は presenters を import してよいが、presenters と `cli/` の外のコードは `cli/` を import しない。eslint の `no-restricted-imports` で止めるかを決める
- **テスト。** 今の CLI のテストは文言を通しで確かめているので、そのまま通ることを確かめる。移した関数の単体テストは移した先に置く

## 背景

画面とサーバは ADR 0017 でいったん外したが、後で React の画面とバックエンドを戻し、CLI と HTTP の両方から同じ usecase につなぐ予定である（ADR 0018）。
今は、usecase が返す `{ type: 'DecisionUnavailable', ... }` のようなデータを「idea-x に 承認 は書けません（今の列: アイデア。出せる判断: plan 中止）」の 1 行にするのが CLI のファイルの中の関数である。
サーバから同じ文言を返そうとすると、CLI のファイルを逆向きに import するか、同じ文言をもう一度書くかになり、どちらも CLI を直したときにずれる。
既に CLI の外の利用者が 1 人いる。PR #103 の `board-view` の `render.mjs` が `dist/board/cli/status-describe.js` を直接 import している。
サーバを戻す前に置き場所を分けておけば、戻すときは presenters を呼ぶだけで済む。
この提案は 2026-11-11、React とバックエンドにするためのリファクタリングを洗い出したときに出た。

## 論点

- **置き場所。** コンテキストごと（`board/presenters/`・`cards/presenters/`）か、1 か所にまとめるか。`data-store-messages` は board と cards の両方が使う
- **`render.mjs` の import の付け替え。** PR #103 が先にマージされたら、`render.mjs` とそのテストの import 先もこのカードで直す
- **HTTP で文言を返すか。** 画面が文言を作らず、サーバが作った 1 行を出すだけにする前提で進めてよいか（エラーの種類と HTTP のステータスの対応は、サーバを戻すときに決める）
- **`cli-usecase-entry` との順。** あちらは CLI のロジックを usecase へ移すカードで、触るファイル（`decide-cli.ts`・`card-cli.ts`）が重なる。どちらを先にするか
