# ボードの拒否のルールを CLI の外の usecase と純関数へ出す

## 人に判断してほしいこと

- なし

## 提案

### Why

画面とサーバを外したので（ADR 0017）、usecase を使うのは CLI だけになった。
それでも、AI が書いてよいものを決めるハードルールの拒否は、CLI の private な関数に残っている。
「提出は着手済みで、plan が未提出か否決のときだけ」「保留は否決のときだけ」の 2 つで、`src/cards/cli/card-cli.ts` の `submitRefusal` / `gateRejected` にある。
拒否は `Refused { message: string }` という文字列のエラーで返している。これは「エラーは discriminated union」の規約から外れる。
`card-cli` の依存には `appendReviewCommand` がそのまま入っている。そのため、承認を書かないことはハンドラの書き方でしか守られていない。

`ai-board decide` の「出せない判断は拒む」検査（`decisionsFor` / `droppableStages` / アイデアの表に入っているかの確認）も、`src/board/cli/decide-cli.ts` の中にある。
この検査は `transact` の外で読んだボードに対して行い、`transact` の中では書き込みだけを行っている。
push が拒否されると、`transact` は取り直して書き込みをやり直すが、検査はやり直さない。
ADR 0010 の「取り直して検査からやり直す」が、`decide` では守られていない。

書き込みの包み方は 2 通りある。サーバのために作った `createTransactionalCardDependencies`（`src/cards/composition.ts`）と、`card-cli` の `transactCard` で、同じ `CardWriteRefusedError` を二重に捕まえている。
画面の SSE に知らせるための `onWrite` も、呼ぶ者がいないまま残っている。

画面はいずれゼロから作り直す（ADR 0017）。そのときも拒否のルールをそのまま使えるよう、ルールを CLI の外へ出しておく。

### What Changes

- 提出と保留を、拒否の検査を持つ別々の usecase（`submitReviewCommand` / `holdReviewCommand`）にする。どちらも `kind` を中で固定する。拒否は discriminated union のエラーで返す
- `card-cli` の依存から `appendReviewCommand` を外し、提出と保留の usecase だけを渡す
- `decide` の拒否の検査を、`Board` を受けて `Result` を返す純関数にする
- 書き込みの包み方を 1 つの関数にまとめ、`createTransactionalCardDependencies` と `onWrite` を消す。`decide` は検査から書き込みまでを `transact` の中で走らせる
- CLI の出力（標準出力・標準エラーの文・終了コード）とコミットのメッセージは変えない

### Impact

- カード: `src/cards/usecases/commands/`（提出と保留の usecase を足す）、`src/cards/errors/card-errors.ts`、`src/cards/composition.ts`、`src/cards/cli/card-cli.ts`、
  `src/cards/repositories/file-card.repository.ts` / `file-idea-divider.repository.ts`（`onWrite` を消す）
- ボード: `src/board/services/decision-guards.ts`（新しい純関数）、`src/board/cli/decide-cli.ts`、`src/cli-main.ts`
- テスト: `src/cards/usecases/__tests__/`、`src/board/services/__tests__/`、`src/board/cli/__tests__/decide-cli.test.ts`、`src/cards/cli/__tests__/card-cli.test.ts`、
  `src/cards/repositories/__tests__/file-idea-divider.repository.test.ts`
- ドキュメント: `CLAUDE.md`、`docs/architecture.md`、`docs/adr/0006-ai-review-entries-and-hold.md`
- 導出（`stage-resolver.ts`）、データ用ブランチの形、CLI の引数と出力、手順書（`.claude/`）は変わらない

## 設計

### Decisions

- **提出と保留の usecase を分ける。** `src/cards/usecases/commands/submit-review.command.ts` と `hold-review.command.ts` を足す。
  - 提出の入力は `{ id, gate, resubmit, reason, at }` で、`kind` は `resubmit` から `提出` / `再提出` に決める。保留の入力は `{ id, gate, reason, at }` で、`kind` は `保留` に固定する。
    入力に `kind` を持たないので、承認 / 否決 / 中止は型の上で渡せない
  - どちらも `cardRepository.findById` で読んだカードの `gateStates` を確かめてから、内側で組んだ `createAppendReviewCommand(cardRepository)` で追記する
  - `appendReviewCommand` には拒否の条件を足さない。人の判断（`decide`）はこれまでどおり `appendReviewCommand` を使う
- **拒否のエラーの種を足す。** `src/cards/errors/card-errors.ts` に次の 3 つを足す。
  - `SubmitBeforeStart { id }`: 着手していないカードへの提出
  - `SubmitGateClosed { id, gate, state }`: ゲートが未提出でも否決でもない
  - `HoldGateNotRejected { id, gate, state }`: ゲートの最新が否決でない

  `SubmitReviewError = CardNotFound | SubmitBeforeStart | SubmitGateClosed | CardWriteFailure`、`HoldReviewError = CardNotFound | HoldGateNotRejected | CardWriteFailure` とする。
  `card-cli` の `describeError` は `switch` でこれを今と同じ文に直し、`Refused` の種を消す

- **カードが無いときの扱い。** 今は「検査は通し、追記の usecase が `CardNotFound` を返す」形である。これを、usecase が検査の前に `CardNotFound` を返す形に変える。出る文は同じ
- **`CardCliDependencies.cards` を `Pick` で絞る。** 渡すのは `cardRepository` / `createCardCommand` / `updateCardBodyCommand` / `updateCardMetaCommand` / `submitReviewCommand` / `holdReviewCommand` だけにする。
  `card-cli` から `appendReviewCommand` を呼ぶと型が通らなくなる
- **保留の理由が要ることの検査は、引数の検査として CLI に残す。** `--reason` が空なら、データ用ブランチに触る前に今と同じ文で拒む
- **`decide` の検査を純関数にする。** `src/board/services/decision-guards.ts` に次の 5 つを置く。
  - `guardReview(board, { id, kind, reason })`
  - `guardStartedAt(board, { id, from, to })`
  - `guardSkip(board, { id })`
  - `guardMove(board, { id, after, before })`
  - `guardMoveDivider(board, { after, before })`

  どれも `Result<BoardCard | null, DecideRefusal>` を返す。返す値は、書く対象のカード（区切り線なら `null`）である。
  `DecideRefusal` は discriminated union で、次の種を持つ。
  - `ForgeUnavailable { action, forge }`
  - `CardNotFound { id }`
  - `DecisionUnavailable { id, kind, card }`
  - `ReasonRequired { kind }`
  - `StageMismatch { id, from, to, card }`
  - `CardAborted { id }`
  - `NotInIdeaTable { ref }`

  人に読める文への直し（`describeChoices` / `forgeHoldNote` を含む）は `decide-cli` に残す

- **引数だけで決まる検査は CLI に残す。** カード ID の形、`--after` / `--before` の値、自分自身を隣に指定することの拒否、`--gate` の値がそれに当たる。どれもボードを読む前に拒む
- **書き込みの包み方を `transactCardWrite(store, message, op)` の 1 つにする。** `src/cards/composition.ts` に置き、`op` が投げた `CardWriteRefusedError` を `CardWriteRefused` の Err に直す。
  `card-cli` の `transactCard` と、`createTransactionalCardDependencies` の `inTransaction` を、これに置き換える。
  `createTransactionalCardDependencies` と `describePatch` は消す
- **`decide` は、ボードの導出・検査・書き込みを 1 回の `transact` の中で走らせる。** push が拒否されたら、取り直した状態でボードを導き直し、検査からやり直す。
  `DecideCliDependencies` は `{ loadBoard, store: Pick<DataStore, 'transact'>, cards }` にし、`cards` には `createFileCardDependencies(store.dataDir)` を渡す。
  コミットのメッセージは今の `createTransactionalCardDependencies` と同じにする。
  - `data: <id> に <gate> <kind> を足す`
  - `data: <id> の startedAt を変える`
  - `data: <id> の skipGates を変える`
  - `data: <id> を並べ替える`
  - `data: 区切り線を動かす`

  列の移りの 1 行は、`transact` の最後の試みで読んだカードを「前」にし、`transact` の後に読み直したボードを「後」にする

- **`onWrite` を消す。** `createFileCardDependencies`、`FileCardRepository`、`FileIdeaDividerRepository` から消し、それを確かめるテストも消す。呼ぶ者はもういない
- **触るファイルの、画面やサーバを前提にした記述を今の形に直す。**
  - `card-cli` の docstring:「UI と HTTP API からだけ行える」
  - `decide-cli` の docstring:「画面のボタンと同じ usecase を、サーバと同じ組み立てで」
  - `DECIDE_USAGE`:「画面で押せない判断は拒む」→「出せない判断は拒む」
  - `cli-main.ts` の `runDecide` / `assembleBoard` の docstring
  - `append-review.command.ts` の「次の `GET /api/board`」
  - `card-errors.ts` の `CardStoreError` の「サーバと CLI が」

### 仮定

- **`transact` の中でボードを導いても、自分を待って止まらず、GitHub にも問い合わせない。** 根拠: `getBoardQuery` は、カードと区切り線と `loop/` をデータのワークツリーのファイルから読み、計画は `plansDir`、PR の状態は `refresh()` 済みの `MrStateProvider` の手元の値から読む。
  PR 番号の書き戻し（`writeMr` の `transact`）が走るのは `poller.refresh()` の中だけで、それは `runDecide` が `transact` の前に 1 回呼ぶ（`src/cli-main.ts` の `assembleBoard`、`src/infrastructure/forge-poller.ts`）。
  実装の最初で `get-board.query.ts` を読み直して確かめる。外れていたら、検査を `transact` の外に置いたままにする代案へ戻し、計画に書き残す
- **`transact` の `op` が受け取る `dataDir` は、`store.dataDir` と同じ場所である。** そのため、`createFileCardDependencies(store.dataDir)` で組んだリポジトリを `op` の中で使ってよい。根拠: 今の `card-cli` と `createTransactionalCardDependencies` が同じ形で使っている
- **ADR は 0006 の 1 行を直すだけにする。** 0006 の「CLI は構造でこれを強制する」を、提出と保留の usecase と `card-cli` の依存の絞り込みで強制する、という今の形に直す。
  ADR 0010 の「取り直して検査からやり直す」は、`decide` がこの変更でようやく守る側に入るので、書き直さない。新しい ADR は立てない。判断の中身（AI と人の境界、検査を `transact` の中に置くこと）は既存の ADR のままだからである
- **手順書（`.claude/`）の振る舞いは変わらないので、`.claude/HARNESS_VERSIONS.md` の版は上げない。** CLI の引数と出力が変わらないためである
- **CLI の出力の文は変えない。** 既存の `card-cli.test.ts` / `decide-cli.test.ts` の期待をそのまま通すことで確かめる

### 退けた代案

- **`appendReviewCommand` に `kind` ごとの拒否を足す** — AI と人の境界が、構造ではなく引数の値で決まるようになる。人の判断も同じ usecase を通るので、提出の条件が承認に効くかを毎回読み分けることになる
- **`decide` の検査も usecase にする** — 検査は導出済みの `Board` だけで決まり、データを読まない。CLAUDE.md の「区画や判断のロジックは純関数に切り出してテストする」に合わせ、純関数にする
- **`decide` の検査を `transact` の外に置いたまま、ADR 0010 の例外として記録する** — `transact` の中で導き直しても GitHub への問い合わせは増えない（仮定）。そのため、例外を残す理由が無い
- **pr / status / loop の CLI も usecase に出す** — pr は `gh` の薄い包みで、重い `nextCheckStep` / `isSettled` はすでに純関数である。status は `buildStatusReport` が純関数で、query もある。loop の書き込みは `writeLoopStart` / `writeLoopFinish` に任せている。層を足しても得るものが無い
- **ブランチの紐付けを専用の usecase にし、`card-cli` から `updateCardMetaCommand` も外す** — `startedAt` / `skipGates` も型の上で書けなくなる利点はある。ただし、この計画の目的（拒否のルールを出す）の外になる（Non-Goals）

### Risks / Trade-offs

- 使う側が CLI だけなので、usecase と純関数を足した分だけ読む場所が増える。拒否のルールは「提出・保留は usecase」「人の判断は `decision-guards.ts`」の 2 か所にまとまる
- `decide` が拒むとき、今はロックと取り直しの前に拒んでいた。この変更の後は、ロックを取り、取り直してから拒む。ロックの待ちの分だけ遅くなりうるが、`card submit` / `card hold` と同じ扱いになる
- `transact` の中でボードを導くので、push が拒否されるたびに導出が 1 回増える。導出はファイルを読むだけで、`transact` のやり直しは 3 回までである

### Non-Goals

- `src/` のほかのファイルに残る、画面やサーバを前提にした記述の掃除（触るファイルだけを直す）
- ブランチの紐付けの専用の usecase
- pr / status / loop の CLI の組み替え
- CLI の引数・出力・終了コードの変更

## 探索メモとの対応

| #   | 探索メモ                                                                                                     | 反映した先                                          | 反映しなかった理由 |
| --- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- | ------------------ |
| 1   | 一緒に直す古いコメント（card-cli の「UI と HTTP API」、decide-cli の「画面のボタンと同じ」、`DECIDE_USAGE`） | Decisions（画面やサーバを前提にした記述）／タスク 4 |                    |
| 2   | 強制する場所が移るので書き直す記述（`CLAUDE.md`、`docs/architecture.md` の 89 行目と 239 行目）              | Impact／タスク 4                                    |                    |
| 3   | 使う側が CLI だけなので、層を増やすと遠回りになるのが代償                                                    | Risks / Trade-offs                                  |                    |

## 動作確認の手順

`AI_BOARD_DATA` でスクラッチパッドの試しのデータのワークツリーを指して動かす（`.claude/skills/board-loop/rules.md` の「動かして確かめるとき」）。
GitHub に繋がらない試しのデータでは、`decide` の承認 / 否決 / 中止と着手 / 着手を戻すが拒まれる。そのため、`decide` の手順は `config.yaml` の `github:` をこのリポジトリに向け、`gh` にログインした環境で走らせる。

| 確かめること                                   | コマンド                                                 | 期待する結果                                                                              |
| ---------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 着手していないカードへの提出を今と同じ文で拒む | `card create --title t --id a1` の後に `card submit a1`  | 「plan の提出は着手したカードにしかできません（着手は人が指示します）」が出て終了コード 1 |
| 着手したカードには提出を書ける                 | `decide start a1` の後に `card submit a1 --reason r`     | `a1` が出て終了コード 0。`card show a1` の `## レビュー` に `plan 提出` が 1 件           |
| 否決でないゲートへの保留を今と同じ文で拒む     | 上の続きで `card hold a1 --gate plan --reason r`         | 「保留は plan の最新の判断が否決のときにしか書けません」が出て終了コード 1                |
| `decide` は書いて列の移りを 1 行で出す         | `card create --title t --id a2` の後に `decide start a2` | `a2: 着手 を書きました（アイデア → 計画提案中）` が出て終了コード 0                       |
| `decide` は出せない判断を今と同じ文で拒む      | 上の続きで `decide approve a2`                           | 「a2 に 承認 は書けません（今の列: 計画提案中。…）」が出て終了コード 1                    |
| コミットのメッセージが変わらない               | `git -C "$S/data" log --format=%s -5`                    | `data: a2 の startedAt を変える` など、今と同じ形のメッセージが並ぶ                       |

## タスク

### 1. 提出と保留を usecase にする

- [ ] `src/cards/errors/card-errors.ts` に `SubmitBeforeStart` / `SubmitGateClosed` / `HoldGateNotRejected` と `SubmitReviewError` / `HoldReviewError` を足す
- [ ] `src/cards/usecases/commands/submit-review.command.ts` と `hold-review.command.ts` を足す。docstring には、今の `runSubmit` / `runHold` の docstring にある「なぜ拒むか」を移す
- [ ] `src/cards/composition.ts` の `CardDependencies` と `assemble` に `submitReviewCommand` / `holdReviewCommand` を足す
- [ ] `src/cards/cli/card-cli.ts` の `runSubmit` / `runHold` を新しい usecase に切り替える。`submitRefusal` / `gateRejected` / `Refused` を消し、`describeError` で新しい種を今と同じ文に直す
- [ ] `CardCliDependencies.cards` を `Pick` で絞り、`appendReviewCommand` を外す
- [ ] `src/cards/usecases/__tests__/` に、提出と保留の usecase のテストを足す。書ける場合、各拒否の種、カードが無い場合、拒んだときに何も追記しないことを確かめる

### 2. decide の検査を純関数にする

- [ ] `src/board/services/decision-guards.ts` に `DecideRefusal` と `guardReview` / `guardStartedAt` / `guardSkip` / `guardMove` / `guardMoveDivider` を置く
- [ ] `src/board/cli/decide-cli.ts` の各ハンドラを、これらの純関数を呼んで `DecideRefusal` を今と同じ文に直す形にする（この節では、検査はまだ `transact` の外のまま）
- [ ] `src/board/services/__tests__/decision-guards.test.ts` に、各関数の通る場合と、各拒否の種のテストを足す

### 3. 書き込みの包み方を 1 つにし、decide の検査を transact の中へ移す

- [ ] `src/board/usecases/queries/get-board.query.ts` を読み直し、導出が `transact` を呼ばないこと（仮定）を確かめる
- [ ] `src/cards/composition.ts` に `transactCardWrite` を足し、`card-cli` の `transactCard` をこれに置き換える
- [ ] `src/board/cli/decide-cli.ts` で、ボードの導出・検査・書き込みを `transactCardWrite` の 1 回の中で走らせる。`DecideCliDependencies` に `store` を足し、コミットのメッセージを今と同じにする
- [ ] `src/cli-main.ts` の `runDecide` で、`createFileCardDependencies(store.dataDir)` と `store` を渡す。`createTransactionalCardDependencies` と `describePatch` を消す
- [ ] `onWrite` を `createFileCardDependencies` / `FileCardRepository` / `FileIdeaDividerRepository` とそのテストから消す
- [ ] `src/board/cli/__tests__/decide-cli.test.ts` を、`op` をそのまま走らせる試しの `store` に切り替える。`transact` の中でカードが変わっていたら（試しの `store` が `op` の前に承認を足す）拒んで何も書かないことと、コミットのメッセージを確かめるテストを足す

### 4. ドキュメントとコメント

- [ ] `CLAUDE.md` の「`ai-board card` の CLI はこれを構造で強制している」を、提出と保留の usecase と依存の絞り込みで強制する形に直す
- [ ] `docs/architecture.md` の「判断と区画」（`card-cli` が拒む条件）と「書き込み」の 3（`submitRefusal`）を、今の置き場所に直す。`decide` の検査も `transact` の中にあることを書く
- [ ] `docs/adr/0006-ai-review-entries-and-hold.md` の「CLI は構造でこれを強制する」を今の形に直す
- [ ] Decisions に挙げた、触るファイルの画面やサーバを前提にした docstring と `DECIDE_USAGE` を直す
