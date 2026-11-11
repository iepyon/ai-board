# 人に読ませる文言を CLI の外の presenters へ移す

## 人に判断してほしいこと

- **カードの書き込みの失敗の文言も移すか。** カードに挙がっていない `src/cards/cli/card-cli.ts` の `describeError`（`CardNotFound`・`DuplicateCardId`・`SubmitGateClosed` など）も、戻す HTTP の入口（カードの起票・本文の編集）で要るので移す（既定: 移す。`src/cards/presenters/card-write-messages.ts` の `describeCardWriteError` にする）
  - → 回答（2026-11-11、plan 承認）: 理由なしで承認（既定のまま進む）
- **`loop` と `init` の CLI の文言は CLI に残すか。** `loop-cli.ts` の `describeError` と `init-cli.ts` の `describeBranchError` は、ループと初期化という CLI でだけ使う操作の文言なので移さない（既定: 残す）
  - → 回答（2026-11-11、plan 承認）: 理由なしで承認（既定のまま進む）
- **`cli/` の外から `cli/` を import できなくする eslint の決まりを足すか。** 足すと、presenters や usecase が CLI のファイルを逆向きに引いたときに lint で落ちる（既定: 足す）
  - → 回答（2026-11-11、plan 承認）: 理由なしで承認（既定のまま進む）

承認は、回答の無い項目をすべて既定のまま進めると読む。既定と違う答えは、差し戻しの理由で返してほしい。

## 提案

### Why

画面とサーバは ADR 0017 でいったん外したが、後で React の画面とバックエンドを戻し、CLI と HTTP の両方から同じ usecase につなぐ予定である（ADR 0018）。
usecase はエラーや拒否を `{ type: 'DecisionUnavailable', ... }` のようなデータで返し、それを「idea-x に 承認 は書けません（今の列: アイデア。出せる判断: plan 中止）」の 1 行にするのは、CLI のファイルの中の関数である。
サーバから同じ文言を返そうとすると、CLI のファイルを逆向きに import するか、同じ文言をもう一度書くかになる。どちらも、CLI を直したときに 2 か所がずれる。

逆向きの import は既に起きている。

- `src/board/cli/decide-cli.ts` / `src/board/cli/loop-cli.ts` が、別のコンテキストの CLI のファイル `src/cards/cli/data-store-messages.ts` を import している
- `board-view` の `render.mjs`（PR #103 でマージ済み）が `dist/board/cli/status-describe.js` を、`src/__tests__/board-view-render.test.ts` が `src/board/cli/status-describe.ts` を直接 import している

文言の関数の置き場所を CLI から分けておけば、サーバを戻すときは presenters を呼ぶだけで済む。

### What Changes

- 人に読ませる文言を作る関数を、`cli/` の外へ移す。移す先は次のとおり
  - `src/board/presenters/status-describe.ts`: `describeNext` / `describeForge` / `describeLoop` / `describeStuck`（`src/board/cli/status-describe.ts` をそのまま移す）
  - `src/board/presenters/decide-messages.ts`: `describeDecideError` / `describeRefusal` / `describeChoices` と、書いた後の列の移りの 1 行（`describeDecided`）
  - `src/board/presenters/pr-messages.ts`: `describePrError`
  - `src/cards/presenters/card-write-messages.ts`: `describeCardWriteError`（今の `card-cli.ts` の `describeError`）
  - `src/infrastructure/data-store-messages.ts`: `describeDataStoreError` / `describeOfflineRead`（`src/cards/cli/data-store-messages.ts` をそのまま移す）
- CLI は presenters を import して、今と同じ文を出す。引数の読み取り・使い方の文・終了コード・標準出力への書き出し・端末向けの並べ方（`formatStatus`・`formatPullRequest` など）は CLI に残す
- `render.mjs` とそのテストの import 先を、移した先に付け替える
- eslint に、`cli/` の外（入口の `src/cli.ts` / `src/cli-main.ts` を除く）から `cli/` を import できなくする決まりを足す
- CLI の出力（標準出力・標準エラーの文・終了コード）は変えない

### Impact

- ボード: `src/board/presenters/`（新規 3 ファイル）、`src/board/cli/decide-cli.ts` / `status-cli.ts` / `pr-cli.ts` / `loop-cli.ts`
- カード: `src/cards/presenters/card-write-messages.ts`（新規）、`src/cards/cli/card-cli.ts` / `init-cli.ts`
- infrastructure: `src/infrastructure/data-store-messages.ts`（`src/cards/cli/` から移す）
- 入口: `src/cli-main.ts`
- スキル: `.claude/skills/board-view/render.mjs`（import 先だけ）
- テスト: `src/board/cli/__tests__/status-describe.test.ts` → `src/board/presenters/__tests__/`、`src/cards/cli/__tests__/data-store-messages.test.ts` → `src/infrastructure/__tests__/`、
  `src/__tests__/board-view-render.test.ts`（import 先だけ）、presenters の新しい単体テスト
- 設定: `eslint.config.js`
- エラーの型: `src/cards/errors/card-errors.ts`（`CardWriteError` を足す）
- ドキュメント: `CLAUDE.md`（コードの規約の「CLI が `switch` で人に読める 1 行へ変換する」）、`docs/architecture.md`
- 導出・usecase・データ用ブランチの形・CLI の引数と出力・手順書の振る舞いは変わらない

## 設計

### Decisions

- **presenters はコンテキストごとに置く。** ボードの文言は `src/board/presenters/`、カードの文言は `src/cards/presenters/` に置く。usecase と同じく、どのコンテキストのエラーかで置き場所を決める
- **データ用ブランチの失敗の文言は `src/infrastructure/` に置く。** `DataStoreError` は `src/infrastructure/data-store.ts` の型で、board と cards の両方が使う。
  外部コマンドの失敗の文言 `describeCliError` が `src/infrastructure/cli-runner.ts` にあるのと同じ置き方にする。ファイルは `src/infrastructure/data-store-messages.ts` とし、中身は変えない
- **presenters の関数は文字列を返す純関数にする。** 入出力（`io`）・終了コード・改行は持たない。改行と `io.stderr` への書き出しは CLI が行う
- **`status-describe.ts` は名前を変えずに移す。** ADR 0019 と `docs/architecture.md` がファイル名で指しているため、ファイル名は保つ。`render.mjs` の import 先は `dist/board/presenters/status-describe.js` にする
- **decide の文言は 1 つのファイルにまとめる。** `describeDecideError` / `describeRefusal` / `describeChoices` と、その下請けの `forgeHoldNote` / `startedAtLabel` を `decide-messages.ts` に移す。外に出すのは `describeDecideError` と `describeRefusal` と `describeDecided` だけにする
- **書いた後の列の移りの 1 行も移す。** 今の `reportWrite` が組む「`<id>: <what> を書きました（<前> → <後>）`」を `describeDecided(decided: Decided): string` にする。
  HTTP でも判断を書いた結果を同じ 1 行で返せるようにするためである。`reportWrite` は `describeDecided` を呼んで `io.stdout` に書くだけにする。
  並べ替えの「`<id>: 並べ替えました`」「区切り線を動かしました」は usecase の結果を使わない決まった文なので、CLI に残す
- **`describePrError` は `src/board/presenters/pr-messages.ts` に移す。** `formatPullRequest` / `formatComments` は `ai-board pr view` の端末向けの並べ方なので CLI に残す
- **カードの書き込みの失敗の文言を移す。** `card-cli.ts` の `describeError` を `describeCardWriteError(error: WriteFailure): string` として `src/cards/presenters/card-write-messages.ts` に移す。
  引数の型 `WriteFailure`（`CreateCardError | UpdateCardError | UpdateCardBodyError | SubmitReviewError | HoldReviewError`）は今 `card-cli.ts` の中の private な型なので、
  `src/cards/errors/card-errors.ts` へ `CardWriteError` の名前で移して export する。エラーの型はほかもそこにあり（`CreateCardError` など）、presenters も CLI もそこから引く
- **eslint の決まりを足す。** `eslint.config.js` に、`src/**/*.ts` のうち `src/**/cli/**`・`src/cli.ts`・`src/cli-main.ts` を除くファイルから、`**/cli/**` を import できなくする `no-restricted-imports` を足す。
  `src/shared/` に既にある `no-restricted-imports` と重なるので、`src/shared/` の設定には同じパターンを足して 1 つの設定の中で並べる（flat config では、同じ規則を後の設定が上書きするため）。
  テスト（`__tests__/`）も対象に含める。2026-11-11 に `grep -rln "from '[^']*/cli/" src | grep -v '/cli/' | grep -vE '^src/cli(-main)?\.ts$'` で確かめると、`cli/` の外から `cli/` を引くファイルは
  `src/__tests__/board-view-render.test.ts`（`status-describe.ts`）だけで、節 2 で import 先を付け替えると無くなる。CLI のテストは `cli/__tests__/` にあって対象外である
- **CLI の出力は変えない。** 既存の `decide-cli.test.ts` / `card-cli.test.ts` / `status-cli.test.ts` / `pr-cli.test.ts` / `loop-cli.test.ts` / `init-cli.test.ts` の期待をそのまま通すことで確かめる

### 仮定

- **新しい ADR は書かない。** 「人に読ませる文言は presenters に置き、`cli/` の外から `cli/` を引かない」は、ADR 0018 の「CLI と HTTP の両方から同じ usecase につなぐ」をコードの置き場所に下ろしただけで、新しい判断ではないため。
  決まりは `CLAUDE.md` のコードの規約と `docs/architecture.md` に書き、eslint で守る
- **HTTP では、サーバが presenters で作った 1 行を返し、画面は文言を作らない。** 根拠: ADR 0018 の「サーバが計算して `StatusReport` で返し、画面は表示だけをする」。
  エラーの種類と HTTP のステータスの対応は、サーバを戻すときに決める（このカードではしない）
- **`refactor-cli-usecase-entry` とは順に進める。** あちらも `decide-cli.ts` / `card-cli.ts` を触るが、このカードが先（アイデアの表の上）で、あちらは後から今の形に合わせればよい。根拠: アイデアの表の並び（2026-11-11）
- **手順書（`.claude/skills/`）の振る舞いは変わらない。** `render.mjs` は import 先が変わるだけで、出す HTML は同じである。手順書の文は変えない

### 退けた代案

- **1 か所（例: `src/presenters/`）にまとめる** — コンテキストの境（board / cards）をまたいだ置き場所になり、usecase やエラーの型の置き方（コンテキストごと）と揃わない
- **`describeDataStoreError` を `src/cards/presenters/` に置く** — `DataStoreError` は infrastructure の型で、board も使う。board から cards の presenters を引くことになり、今の「board が cards の cli を引く」逆向きの依存の形が残る
- **文言を `src/shared/` に置き、画面でも文言を作れるようにする** — ADR 0018 は「計算はサーバ側に置き、画面は表示だけ」と決めている。文言の関数は `STAGE_LABELS` 以外にも board の型と `decisionsFor` を引くので、`shared` の決まり（コンテキストを import しない）にも反する
- **エラーをコード（例: `E_DECISION_UNAVAILABLE`）にして、文言は画面が持つ** — CLI と画面で文言が 2 組になり、このカードの目的（同じ 1 行を返す）に反する
- **`loop-cli.ts` / `init-cli.ts` の文言も移す** — ループの 1 手の記録と初期化は CLI でだけ使う操作で、HTTP の入口から呼ぶ見込みが無い（人に判断してほしいこと）

### Risks / Trade-offs

- **ファイルが増え、文言を探す場所が CLI と presenters の 2 か所になる。** 「`cli/` は引数と出力だけ、文言は presenters」と `CLAUDE.md` に書き、eslint の決まりで逆向きの import を止めて、迷いを減らす
- **`render.mjs` は `dist/` のパスを文字列で持つので、型検査では付け替え漏れに気付けない。** `src/__tests__/board-view-render.test.ts` は `src` の関数を渡して純関数だけを試すので、`render.mjs` の入口の import は試さない。
  動作確認の手順で、ビルドした `dist` に対して `render.mjs` を走らせて確かめる
- **移すだけで文言を変えない約束が、テストの期待に頼る。** 既存の CLI のテストが文言を通しで確かめているので、移した後もそのまま通ることを確かめる

### Non-Goals

- 文言（標準エラー・標準出力の文）の言い回しを変えること
- `loop-cli.ts` / `init-cli.ts` の文言を移すこと（人に判断してほしいこと）
- CLI に残るロジック（取り直しの段取り・seed の判定・理由の検査・CI の待ち方）を usecase へ移すこと（`refactor-cli-usecase-entry` のカード）
- エラーの種類と HTTP のステータスの対応、サーバの入口を作ること
- `status --json` の出す形を固めること（`refactor-status-json-contract` のカード）

## 探索メモとの対応

| #   | 探索メモ                                                                               | 反映した先 | 反映しなかった理由                                       |
| --- | -------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------- |
| 1   | 人と決めた（2026-11-11）: 計画レビューは不要（着手と一緒に plan を飛ばす宣言を入れた） | —          | 計画の中身は変わらない。提出がそのまま承認と読まれるだけ |

## 動作確認の手順

`AI_BOARD_DATA` でスクラッチパッドの試しのデータのワークツリーを指して動かす（`.claude/skills/board-loop/rules.md` の「動かして確かめるとき」）。
試しのデータは GitHub に繋がらないので、`config.yaml` を置かない（未設定のボード。`decide` の判断を拒まない）。

| 確かめること                                      | コマンド                                                                                                                                            | 期待する結果                                                                                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 品質ゲートが通る                                  | `npm run typecheck && npm run lint && npm run format:check && npm test`（`$WT` で）                                                                 | すべて通る                                                                                                           |
| `cli/` の外から `cli/` を import していない       | `grep -rln "from '[^']*/cli/" src \| grep -v '/cli/' \| grep -vE '^src/cli(-main)?\.ts$'`（`$WT` で。行ではなくファイルのパスで外す）               | 何も出ない                                                                                                           |
| データ用ブランチが無いときの文言が変わらない      | 空の bare リポジトリを `origin` にした clone を `AI_BOARD_DATA` で指し、`init` の前に `card list`                                                   | 「データ用ブランチ（origin の ai-board/data）がありません（…）。ai-board init を走らせてください」が出て終了コード 1 |
| decide の拒否の文言が変わらない                   | `init` の後、`card create --title t --id a1` → `decide approve a1`                                                                                  | 「a1 に 承認 は書けません（今の列: アイデア。出せる判断: plan 中止）」が出て終了コード 1                             |
| decide の書いた後の 1 行が変わらない              | 上の続きで `decide start a1`                                                                                                                        | `a1: 着手 を書きました（アイデア → 計画提案中）` が出て終了コード 0                                                  |
| カードの書き込みの失敗の文言が変わらない          | 上の続きで `card create --title t --id a1`                                                                                                          | 「同じ ID のカードが既にあります: a1」が出て終了コード 1                                                             |
| `board-view` のページがビルドした `dist` で作れる | `AI_BOARD_DATA=... node dist/cli.js status --json --active \| node .claude/skills/board-view/render.mjs > <スクラッチパッド>/page.html`（`$WT` で） | 終了コード 0 で HTML が出て、`a1` のカードが埋め込まれている                                                         |
| eslint の決まりが逆向きの import を止める         | 試しに `src/board/usecases/` の 1 ファイルへ `import '../../cli/status-cli.js'` を足して `npx eslint` を走らせ、元に戻す                            | `no-restricted-imports` で落ちる                                                                                     |

## タスク

### 1. infrastructure とカードの文言を移す

- [x] `src/cards/cli/data-store-messages.ts` を `src/infrastructure/data-store-messages.ts` へ `git mv` し、import を直す（`card-cli.ts` / `init-cli.ts` / `decide-cli.ts` / `loop-cli.ts` / `cli-main.ts`）
- [x] `src/cards/cli/__tests__/data-store-messages.test.ts` を `src/infrastructure/__tests__/` へ `git mv` し、import を直す
- [x] `card-cli.ts` の `WriteFailure` を `src/cards/errors/card-errors.ts` の `CardWriteError` に移し、`describeError` を `src/cards/presenters/card-write-messages.ts` の `describeCardWriteError` に移す。`card-cli.ts` はそれらを引く
- [x] `src/cards/presenters/__tests__/card-write-messages.test.ts` に、カードの書き込みの失敗の種ごとの文と、`DataStoreError` を `describeDataStoreError` に回すことのテストを足す

### 2. ボードの文言を移す

- [x] `src/board/cli/status-describe.ts` を `src/board/presenters/status-describe.ts` へ、`src/board/cli/__tests__/status-describe.test.ts` を `src/board/presenters/__tests__/` へ `git mv` し、import を直す（`status-cli.ts` / `decide-cli.ts` / `src/__tests__/board-view-render.test.ts`）
- [x] `.claude/skills/board-view/render.mjs` の import 先を `dist/board/presenters/status-describe.js` に直す
- [x] `decide-cli.ts` の `describeDecideError` / `describeRefusal` / `describeChoices` / `forgeHoldNote` / `startedAtLabel` を `src/board/presenters/decide-messages.ts` に移し、`reportWrite` の 1 行を `describeDecided` にする。`decide-cli.ts` はそれらを呼ぶ
- [x] `pr-cli.ts` の `describePrError` を `src/board/presenters/pr-messages.ts` に移し、`pr-cli.ts` はそれを呼ぶ
- [x] `src/board/presenters/__tests__/decide-messages.test.ts` に、`describeDecided`（列が変わる・変わらない・読めない）と、`describeDecideError` の拒否の種ごとの文のテストを足す。`pr-messages.ts` には `describePrError`（HTTP のステータスの有無）のテストを足す

### 3. 決まりを守らせ、ドキュメントを直す

- [x] `eslint.config.js` に、`cli/` の外から `cli/` を import できなくする `no-restricted-imports` を足す（Decisions のとおり、`src/shared/` の設定にも同じパターンを並べる）
- [x] `CLAUDE.md` のコードの規約の「CLI が `switch` で人に読める 1 行へ変換する」を、presenters が変換し CLI と（戻す）HTTP の両方が呼ぶ形に直す。`cli/` の外から `cli/` を import しないことも書く
- [x] `docs/architecture.md` の `status-describe.ts` の記述に置き場所（`src/board/presenters/`）を添え、presenters の置き方（コンテキストごと、データ用ブランチの失敗は infrastructure）を 1 段落で書く
- [x] 動作確認の手順の `grep` で、`cli/` の外から `cli/` を引く import が残っていないことを確かめる

## AI レビュー

- [x] `CLAUDE.md:108` の「`cli/` は引数・使い方・終了コード・出力だけを持つ」と `docs/architecture.md:89` の「人に読ませる 1 行（エラー・拒否・…）は presenters の純関数が作る」は例外の無い決まりとして読めるが、計画の Decisions（人に判断してほしいことの回答）で `loop-cli.ts:257` の `describeError` と `init-cli.ts:104` の `describeBranchError` は CLI に残すと決めており、食い違う。後から読んだエージェントがそれらを presenters へ移そうとしうる。両方の文に「CLI でだけ使う操作（`loop` / `init`）の文言と、端末向けの並べ方（`formatStatus` / `formatPullRequest` など）は `cli/` に残す」と例外を書き足す
- [x] `REVIEW.md:26-27` の Important「エラー種の網羅漏れ」が、まだ「CLI のエラーの文言の `switch` が網羅していないもの」と書いている。この PR で `switch` は presenters（`src/board/presenters/decide-messages.ts` / `src/cards/presenters/card-write-messages.ts` / `src/infrastructure/data-store-messages.ts`）へ移ったので、`CLAUDE.md:106-107` と同じく「presenters のエラーの文言の `switch`」に直す
- [x] `docs/architecture.md:17` の「各コンテキストは `models/ errors/ services/ repositories/ usecases/ cli/ composition.ts` を持つ」に、この PR で board と cards に足した `presenters/` が無い。`presenters/` を並べに足す

### 見送った指摘

- `src/board/presenters/__tests__/decide-messages.test.ts` は、タスク 2 の「拒否の種ごとの文」のうち `DecisionUnavailable` と `StageMismatch`（`describeChoices` / `forgeHoldNote` / `startedAtLabel` を通るもの）を試していない。文言は移しただけで変わっておらず、`src/board/cli/__tests__/decide-cli.test.ts:254` / `:261` / `:273` / `:333` / `:340` が CLI を通して同じ文を確かめているので見送る。HTTP の入口を戻して presenters を直接呼ぶときに足すのがよい
- `.claude/skills/board-view/render.mjs:97` が `dist/board/presenters/status-describe.js` を引くようになったので、`dist/` が古いと、前のように古い文言で動くのではなく `ERR_MODULE_NOT_FOUND` で落ちる。`dist-check`（`src/infrastructure/dist-check-cli.ts`）が `dist/cli.js` の mtime と HEAD のコミット時刻を比べるだけなので、GitHub でマージした後にその時刻より新しい古い `dist/` が残ると「新しい」と判定される。判定の弱さは前からあり、落ちてもビルドし直せば直って人が気づけるので、この PR の目的の外として見送る
- `src/board/presenters/decide-messages.ts:87` / `:91` の `CardNotFound` / `CardWriteRefused` の文は、`src/cards/presenters/card-write-messages.ts` の同じ種の文と同じ文字列を別に書いている。また同じファイルの `describeRefusal` の `case 'CardNotFound'`（`:49`）は、`describeDecideError` が先に `CardNotFound` を受けるのでそこからは通らない。どちらも `main` の `decide-cli.ts` からそのまま移した重複で振る舞いは変わらないので、移すだけの PR では見送る
- `eslint.config.js` の `cli/` の import の禁止は、後の設定で `no-restricted-imports` を上書きすると外れるので、`src/shared/` の設定と同じく `NO_CLI_IMPORT` を手で並べ続ける必要がある。今の設定では正しく効いている（`src/board/usecases/` / `src/shared/` / `src/infrastructure/__tests__/` から `cli/` を引くと落ちることを確かめた）ので、作りの好みとして見送る
- `src/cards/errors/card-errors.ts:79` の `CardWriteError` は、既にある `CardWriteFailure` / `CardWriteRefused` と名前が近い。計画の Decisions で決めた名前で、名前の好みなので見送る
