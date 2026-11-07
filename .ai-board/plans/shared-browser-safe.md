# src/shared をブラウザでも動く値と型だけに絞る

## 人に判断してほしいこと

- `stage-labels.ts`（`STAGE_LABELS`）を `src/shared/` に残すか。既定: 残す。戻す画面が列の見出しに値として使うため
  - → 回答（2026-11-07、plan 承認）: 理由なしで承認（既定のまま進む）
- `card-reorder.ts`（`DIVIDER_ID` だけのファイル）の名前を変えるか。既定: 変えない（この計画では動かさない）
  - → 回答（2026-11-07、plan 承認）: 理由なしで承認（既定のまま進む）
- 動きなしの判定（`isStale`）を、カードの論点のように区画とは別のファイルに分けるか。既定: 分けず、区画のファイル（`board-sections.ts`）に残す。`isAwaitingPrFix` に依り、使う側も区画と同じ `get-status.query` だけのため
  - → 回答（2026-11-07、plan 承認）: 理由なしで承認（既定のまま進む）
- `src/shared/` の決まりを新しい ADR（0018）に書くか。既定: 書く。画面を戻すときに「`shared` に何を置くか」を迷わないよう、判断と退けた代案を残す
  - → 回答（2026-11-07、plan 承認）: 理由なしで承認（既定のまま進む）

既定と違う答えは、plan 承認の理由ではなく plan 差し戻しの理由で返してほしい。plan 承認は、回答の無い項目をすべて既定のまま進めると読む。

## 提案

### Why

画面とサーバは ADR 0017 でいったん外したが、後で戻し、CLI と HTTP の両方から同じ usecase につなぐ。
今の `src/shared/` の 12 ファイルのうち 7 つ（`board-sections` / `pr-feedback` / `loop-step` / `loop-activity` / `loop-streak` / `stage-labels` / `stage-gates`）は board からしか使われていない。
画面のために `shared` に置いていたものが、画面を外した後も残っている。

そのため「`shared` はコンテキストの型を引かない」という決まりだけが残り、値を書き写す回避策が増えている。

- `stage-gates.ts` と `board-sections.ts` が `ReviewGate` の `'plan'` を文字で書き写している（ゲートを足すと 3 か所で食い違う）
- `board-sections.ts` の `effectiveRankOf` が `cards/services/card-order.ts` の `effectiveRank` を写している
- `SectionCard` が `CardHold` の形を書き直し、`next-action.ts` が逆に `CardHoldKind` を `shared` から引いている
- `loop-history.repository.ts` の `LOOP_VOCABULARY_IN_SYNC` の docstring が、`shared` の縛りを理由に挙げている

また `config.ts` と `git-worktree.ts` は `node:fs` を使う。画面を戻したときにブラウザのビルドへ巻き込まれると壊れる。

画面を戻すときは「計算はサーバ、画面は表示だけ」にする（人と決めた）。
区画・出せる判断・動きなしは、今も `get-status.query` が `StatusReport` に詰めて返している。
画面は型を `import type` で引けば足り、`shared` には実行時の値として画面が要るものだけを置けばよい。

### What Changes

使う人から見た振る舞いは変わらない（`status` / `decide` / `card` / `loop` / `pr` の出力は同じ）。中の変化は次のとおり。

- board だけが使う純関数と型を `src/board/` へ移す
  - `src/board/services/`: `board-sections.ts`（区画と並び・動きなし）、`decision-options.ts`（出せる判断）、`idea-tiers.ts`（アイデアの区切り）、`pr-feedback.ts`、`loop-activity.ts`、`loop-streak.ts`、`stage-gates.ts`
  - `src/board/models/`: `loop-step.ts`（1 手の記録の語彙と型）
- `config.ts` と `git-worktree.ts` を `src/infrastructure/` へ移す
- 書き写しを本物の import に置き換える（`ReviewGate`・`effectiveRank`・`CardHold`）
- eslint で、`src/shared/**` から `node:*`・Node の組み込みモジュール・`board/`・`cards/`・`infrastructure/` を import できなくする
- 移した後の `src/shared/` は `result.ts`・`schemas/common.ts`・`card-reorder.ts`（`DIVIDER_ID`）・`stage-labels.ts` の 4 つ

### Impact

- 移すファイル: `src/shared/` の 9 ファイルと、`src/shared/__tests__/` のテスト 6 本
- import を直すファイル: `src/board/`（cli・models・services・usecases・repositories・errors・composition とテスト）、`src/cards/`（`composition.ts`・`cli/init-cli.ts`・`cli/data-store-messages.ts`）、`src/infrastructure/data-store.ts`、`src/cli-main.ts`
- 設定: `eslint.config.js`
- ドキュメント: `docs/architecture.md`、`CLAUDE.md`、`REVIEW.md`、`.claude/skills/board-loop/fix-pr.md`、`docs/adr/0017-remove-web-and-server.md`（ファイルの場所）、`docs/adr/0018-shared-browser-safe.md`（新規）、`docs/adr/README.md`（一覧）
- データ用ブランチの形・CLI の出力・ステージの導出は変えない

## 設計

### Decisions

#### `src/shared/` に置いてよいもの

「ブラウザでも動き、2 つ以上のコンテキスト（board / cards / infrastructure / 戻す画面）が実行時の値として使うもの」だけを置く。
型だけを使う側は、置き場所を問わず `import type` で引ける（ビルドで消える）ので、型の共有は `shared` に置く理由にならない。

| ファイル                              | 置き場所                             | 理由                                                                      |
| ------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| `result.ts`                           | `shared` に残す                      | 全コンテキストが使う                                                      |
| `schemas/common.ts`                   | `shared` に残す                      | `Stage` / `CardId` / Zod のスキーマ。全コンテキストと画面が使う           |
| `card-reorder.ts`                     | `shared` に残す                      | `DIVIDER_ID` を board と cards が値として使う。画面の並べ替えも使う見込み |
| `stage-labels.ts`                     | `shared` に残す                      | 画面が列の見出しに値として使う見込み                                      |
| `board-sections.ts`                   | `board/services/` へ（3 つに分ける） | board だけが使う                                                          |
| `pr-feedback.ts`                      | `board/services/` へ                 | board だけが使う                                                          |
| `loop-step.ts`                        | `board/models/` へ                   | 型と語彙。board だけが使う                                                |
| `loop-activity.ts` / `loop-streak.ts` | `board/services/` へ                 | board だけが使う                                                          |
| `stage-gates.ts`                      | `board/services/` へ                 | board だけが使う                                                          |
| `config.ts` / `git-worktree.ts`       | `infrastructure/` へ                 | `node:fs` を使う。ブラウザでは動かない                                    |

#### `board-sections.ts` の分け方

- `board/services/board-sections.ts`: `BoardSection`・`SECTION_OF_STAGE`・`SectionCard`・`Sections`・`groupBySection`・`isAwaitingPrFix`・`waitingSince`・`mergedAt`・`STALE_DAYS`・`isStale`
- `board/services/decision-options.ts`: `DecisionGate`・`Decision`・`DecisionCard`・`decisionsFor`
- `board/services/idea-tiers.ts`: `IdeaTiers`・`splitIdeas`・`IdeaRow`・`ideaRows`

テスト `board-sections.test.ts` も同じ 3 つに分けて `board/services/__tests__/` へ移す。テストの中身（期待値）は変えない。

#### 書き写しを import に置き換える

- `DecisionGate` は `ReviewGate`（`cards/models/review.ts`）の別名にする（`export type DecisionGate = ReviewGate`）。`GATE_OF_STAGE` と `withSkipGate` の `'plan'` も `ReviewGate` にする
- `idea-tiers.ts` の `effectiveRankOf` を消し、`cards/services/card-order.ts` の `effectiveRank` を import する
- `CardHoldKind` を `next-action.ts` へ移し（`CardHold` の隣）、`SectionCard.hold` を `CardHold | null` にする。`board-sections.ts` は `next-action.ts` から型だけを引く
- `LOOP_VOCABULARY_IN_SYNC` は残し、docstring の理由を「`ai-board loop start` が値の一覧を実行時に要るため、型と配列を 2 か所に持つ」に直す

#### eslint の決まり

`eslint.config.js` に `files: ['src/shared/**/*.ts']`（`__tests__` を除く）の `no-restricted-imports` を足す。

- `node:*` と、接頭辞の無い Node の組み込みモジュール（`fs` / `path` / `os` / `child_process` / `url` / `crypto`）を拒む
- `**/board/**`・`**/cards/**`・`**/infrastructure/**` を拒む
- メッセージに「`src/shared/` はブラウザでも動く値と型だけを置く（ADR 0018）」と書く

`shared` のテスト（`src/shared/__tests__/`）は対象から外す。テストは Node で動き、画面のビルドに入らないため。

### 仮定

- `stage-labels.ts` は画面が値として使うので `shared` に残す。根拠: 人と決めた方針（画面と共有するのは型と表示用の値だけ）。表示用の値の代表が列の見出し
- `isStale` は区画のファイルに残す。根拠: `isAwaitingPrFix` に依り、呼ぶのは `get-status.query` の区画を作る箇所だけ
- board から `cards/models/review.ts` と `cards/services/card-order.ts` を引いてよい。根拠: board は既に `cards/models/card.ts`・`cards/services/review-log.ts` を引いている（`board-card.ts`）。cards から board への依存は無いので循環しない
- 移動は `git mv` で行い、履歴を追えるようにする
- archive の計画（`.ai-board/plans/archive/`）の中の古いパスは直さない。根拠: 当時の記録である
- ADR は `adr` のスキルの書き方に従う

### 退けた代案

- `shared` をそのままにして、eslint だけ足す: 回避策（書き写し）が残り、`node:fs` を使う `config.ts` が決まりに反するので足せない
- 区画・出せる判断を `shared` に残し、画面でも計算する: ADR 0017 が挙げた「`shared/` を両方でビルドする制約」が戻る。サーバが計算して `StatusReport` で返す方針（人と決めた）に反する
- 画面と共有する API の型を `src/shared/api/` に今から作る: サーバを戻すときに決めることで、このカードの範囲の外（人と決めた）
- `isStale` を別ファイルにする（カードの論点の案）: 区画の判定（`isAwaitingPrFix`）を引くだけの小さなファイルになり、読む場所が増える（人に判断してほしいこと）
- eslint ではなく `tsconfig` の分割（`shared` だけ `lib: ["DOM"]` で `types: []`）で Node の API を拒む: 設定が二重になり、`board/` への import は拒めない

### Risks / Trade-offs

- import のパスを大量に書き換える。品質ゲート（`typecheck`）が取りこぼしを拾う
- `board-sections.test.ts`（474 行）を 3 つに分けるとき、テストを落とすおそれがある。分ける前後でテストの件数を数えて同じであることを確かめる
- 画面を戻したときに、`shared` に足りない値が見つかるかもしれない。そのときは決まり（ADR 0018）に照らして足す

### Non-Goals

- 振る舞いの変更（CLI の出力・ステージの導出・データの形）
- 画面・サーバ・HTTP の API を戻すこと、API 専用の型を作ること
- `card-reorder.ts` の名前の変更（人に判断してほしいこと）
- CLI の層に残るロジックの usecase への移動（`cli-usecase-entry` のカード）
- `github-client.ts` / `data-store.ts` など大きいファイルの分割

## 探索メモとの対応

| #   | 探索メモ（短い引用）                                                                                                         | 反映した先                                                   | 反映しなかった理由 |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------ |
| 1   | 人と決めた（2026-11-07）: 画面とサーバは後で戻す。戻すときは計算をサーバ側に置き、画面と共有するのは型と表示用の値だけにする | Why、Decisions「`src/shared/` に置いてよいもの」、退けた代案 |                    |
| 2   | API 専用の型を別に作るかは、サーバを戻すときに決める。このカードでは扱わない                                                 | Non-Goals、退けた代案                                        |                    |
| 3   | 画面側で計算が要る場合は、その純関数だけを `shared` に戻す。画面の要件が見えてから決める                                     | Risks / Trade-offs、ADR 0018（タスク 5）                     |                    |

## 動作確認の手順

1. 品質ゲートが通る: `npm run typecheck && npm run lint && npm run format:check && npm test` → すべて成功
2. `src/shared/` に残るファイルが 4 つ（とテスト）だけ: `find src/shared -name '*.ts' -not -path '*__tests__*' | sort` → `card-reorder.ts` / `result.ts` / `schemas/common.ts` / `stage-labels.ts`
3. eslint の決まりが効く: スクラッチパッドにコピーした作業ツリーで `src/shared/result.ts` に `import * as fs from 'node:fs';` と `import '../board/composition.js';` を足し、`npx eslint src/shared/result.ts` → 2 件とも `no-restricted-imports` で失敗する（作業ツリーには残さない）
4. 区画のテストの件数が分ける前と同じ: 分ける前の `npx vitest run src/shared/__tests__/board-sections.test.ts` の件数と、分けた後の 3 本の合計 → 一致する
5. `status` の出力が変わらない: `rules.md` の「動かして確かめるとき」の手順で、本物の `ai-board/data` を bare リポジトリに clone して `AI_BOARD_DATA` で指し、`main` のビルドとこのブランチのビルドで `status --json --only waiting,working,ideas,next` を出して `diff` → 差分なし（`generatedAt` などの時刻は除く）
6. 戻す画面から `shared` を引けるか（人が確かめる。画面はまだ無いので走らせていない）

## タスク

### 1. board 専用の純関数と型を board へ移す

- [x] `git mv` で `pr-feedback.ts`・`loop-activity.ts`・`loop-streak.ts`・`stage-gates.ts` を `src/board/services/` へ、`loop-step.ts` を `src/board/models/` へ移し、テスト（`pr-feedback` / `loop-activity` / `loop-streak` / `stage-gates`）も各 `__tests__/` へ移す
- [x] `board-sections.ts` を `src/board/services/` へ移し、テストも `src/board/services/__tests__/` へ移す（分けるのは 2）
- [x] 移したファイルと、それを引く側の import を直す
- [x] `GATE_OF_STAGE`・`withSkipGate`・`DecisionGate` の `'plan'` を `ReviewGate` にする
- [x] `CardHoldKind` を `next-action.ts` へ移し、`SectionCard.hold` を `CardHold | null` にする。`SectionCard` の古い docstring（`src/shared/` は型を import しない）を消す
- [x] `LOOP_VOCABULARY_IN_SYNC` と `loop-step.ts` の docstring から、`src/shared/` に置く理由の記述を直す

### 2. `board-sections.ts` を 3 つに分ける

- [x] 分ける前の `board-sections.test.ts` のテストの件数を控える
- [x] 出せる判断を `decision-options.ts` へ、アイデアの区切りを `idea-tiers.ts` へ分け、テストも同じ単位で分ける
- [x] `effectiveRankOf` を消し、`effectiveRank` を import する
- [x] 引く側（`get-status.query.ts`・`decision-guards.ts`・`decide-cli.ts`・`status-report.ts`・`board-errors.ts`・`next-action.ts`）の import を直す
- [x] 分けた後のテストの件数の合計が、控えた件数と同じであることを確かめる

### 3. 設定とワークツリーの解決を infrastructure へ移す

- [ ] `git mv` で `config.ts`・`git-worktree.ts` とテストを `src/infrastructure/` と `src/infrastructure/__tests__/` へ移す
- [ ] 引く側（`cli-main.ts`・`board/composition.ts`・`board/services/github-client.ts`・`board/cli/pr-cli.ts`・`cards/composition.ts`・`cards/cli/init-cli.ts`・`cards/cli/data-store-messages.ts`・`infrastructure/data-store.ts` とテスト）の import を直す

### 4. eslint で `src/shared/` の決まりを強制する

- [ ] `eslint.config.js` に `src/shared/**/*.ts`（`__tests__` を除く）の `no-restricted-imports` を足す
- [ ] 動作確認の手順 3 を走らせ、決まりが効くことを確かめる（作業ツリーには残さない）

### 5. ドキュメントを今の形に直す

- [ ] `docs/architecture.md` のディレクトリの説明（`shared/` の行）と、移したファイルへの参照を直す
- [ ] `CLAUDE.md` と `REVIEW.md` の `src/shared/board-sections.ts` を、移した先に直す
- [ ] `.claude/skills/board-loop/fix-pr.md` の `src/shared/pr-feedback.ts` を直す
- [ ] `docs/adr/0017-remove-web-and-server.md` の `src/shared/board-sections.ts` の場所を直す
- [ ] `adr` のスキルで `docs/adr/0018-shared-browser-safe.md` を書き、`docs/adr/README.md` の一覧に足す
