---
id: shared-browser-safe
title: AIエージェントは、src/shared をブラウザでも動く値と型だけに絞り、board 専用の純関数を board へ移したい
created: '2026-11-07T13:23:04.411Z'
skipGates: []
branch: null
pr: null
---

## アイデア

`src/shared/` を「ブラウザでも動く値と型だけ」に絞る。board だけが使うファイルは `src/board/` へ、`node:fs` を使うファイルは `src/infrastructure/` へ移す。
あわせて `board-sections.ts` を関心ごとに分け、`shared` の import の決まりを eslint で強制する。動きは変えない。

## 背景

画面とサーバは ADR 0017 でいったん外したが、後で戻し、CLI と HTTP の両方から同じ usecase につなぐ予定である。
2026-11-07 のコード調査で、`shared` の 12 ファイルのうち 7 つ（`board-sections` / `pr-feedback` / `loop-step` / `loop-activity` / `loop-streak` / `stage-labels` / `stage-gates`）が board からしか使われていないと分かった。
画面のために置いていたものが、画面を外した後も残っている。

そのため「`shared` はコンテキストの型を引かない」という決まりだけが残り、値を書き写す回避策が増えている。

- `stage-gates.ts` と `board-sections.ts` が `ReviewGate` の `'plan'` を文字で書き写している（ゲートを足すと 3 か所で食い違う）
- `board-sections.ts` の `effectiveRankOf` が `cards/services/card-order.ts` の `effectiveRank` を写している
- `SectionCard` が `BoardCard` の `hold` などの形を書き直している

`config.ts` と `git-worktree.ts` は `node:fs` を使うので、画面を戻したときにブラウザのビルドへ巻き込まれると壊れる。

画面を戻すときの方針は「計算はサーバ、画面は表示だけ」にする。
区画・出せる判断・動きなしは、今も `get-status.query` が `StatusReport` に詰めて返している。画面は型を `import type` で引けば足り、実行時の値として要るものだけを `shared` に置く。

## 論点

- 移した後の `shared` に残すもの: `result.ts`、`schemas/common.ts`（`Stage` / `CardId`）、`DIVIDER_ID`、`STAGE_LABELS` で足りるか
- `board-sections.ts` の分け方: 区画と並び / 出せる判断（`decisionsFor`）/ 動きなし（`isStale`）/ アイデアの区切り（`splitIdeas` / `ideaRows`）
- `effectiveRankOf` を `cards` の `effectiveRank` の import に置き換える。board から cards の services を引いてよいか
- eslint の `no-restricted-imports` で、`src/shared/**` から `node:*`・`board/`・`cards/` を import できなくする
- `docs/architecture.md` の構成の説明（`shared/` の行、各ファイルへの参照）を直す

## 探索メモ

- 人と決めた（2026-11-07）: 画面とサーバは後で戻す。戻すときは計算をサーバ側に置き、画面と共有するのは型と表示用の値だけにする
- API 専用の型を別に作るか（`StatusCard = Omit<BoardCard, 'body'>` が内部のモデルをそのまま出している）は、サーバを戻すときに決める。このカードでは扱わない
- 画面側で計算が要る場合（並べ替えを応答前に画面へ反映するなど）は、その純関数だけを `shared` に戻す。画面の要件が見えてから決める
