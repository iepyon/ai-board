# ボードの拒否のルールを CLI の外の usecase と純関数へ出す

## 人に判断してほしいこと

- **`decide` の検査を `transact` の中へ移すか。** 移すと、検査と書き込みの間にほかの誰かがカードに書いても、古いボードに対する検査のまま書かなくなる。その代わり、拒むのはロックを取って fetch した後になる（既定: 移す）
  - → 回答（2026-11-06、plan 否決）: decide の検査は transact の中へ移す。
- **`card` の CLI から `updateCardMetaCommand` を外し、ブランチの紐付けの専用の usecase に替えるか。** 替えると、`startedAt` と `skipGates` も `card` の CLI から型の上で書けなくなる（既定: 今回は入れない）
  - → 回答（2026-11-06、plan 否決）: ブランチの紐付けの usecase は今回入れない。
- **画面やサーバを前提にした古い記述を、どこまで直すか。** `src/` の 37 ファイルほどに残っている（既定: この計画で触るファイルだけ）
  - → 回答（2026-11-06、plan 否決）: 画面やサーバを前提にした古い記述は src 全体を掃除する。
- **保留の `--reason` が要ることを、どこで確かめるか。**（既定: 引数の検査として CLI に残す）
  - → 回答（2026-11-06、plan 否決）: 保留の理由の必須は CLI に残す。
- **画面のためだけに残ったコードも消すか。** 記述を掃除する中で、画面からしか使われていなかった関数が見つかる。例えば、`src/shared/card-reorder.ts` の `moveTargetFor` / `applyMove` はテストからしか使われていない（既定: 消さない。この計画では記述だけを直し、見つけた関数は PR の本文に一覧で挙げる）
  - → 回答（2026-11-06、plan 否決）: 画面のためだけに残ったコードも消して欲しい。

## 提案

### Why

画面とサーバを外したので（ADR 0017）、usecase を使うのは CLI だけになった。
それでも、AI が書いてよいものを決めるハードルールの拒否は、CLI の private な関数に残っている。
「提出は着手済みで、plan が未提出か否決のときだけ」「保留は否決のときだけ」の 2 つで、`src/cards/cli/card-cli.ts` の `submitRefusal` / `gateRejected` にある。
拒否は `Refused { message: string }` という文字列のエラーで返している。これは「エラーは discriminated union」の規約から外れる。
`card-cli` の依存には `appendReviewCommand` がそのまま入っている。そのため、承認を書かないことはハンドラの書き方でしか守られていない。

`ai-board decide` の「出せない判断は拒む」検査（`decisionsFor` / `droppableStages` / アイデアの表に入っているかの確認）も、`src/board/cli/decide-cli.ts` の中にある。
この検査は `transact` の外で読んだボードに対して行い、`transact` の中では書き込みだけを行っている。
検査の後、ロックを取るまでの間に、ほかのセッションがそのカードに書くことがある。そうなると、`transact` は最新の状態を取り直すが、検査はやり直さずに書く。
push が拒否されて書き込みをやり直すときも同じである。
ADR 0010 の「取り直して検査からやり直す」が、`decide` では守られていない。

画面とサーバを外した後も、`src/` の 37 ファイルほどのコメントとテスト名には、画面やサーバが今もあるとする記述が残っている。
今は無いファイル（`src/shared/markdown.ts`）や、今は無いエンドポイント（`GET /api/board`）を指すものもある。

書き込みの包み方は 2 通りある。サーバのために作った `createTransactionalCardDependencies`（`src/cards/composition.ts`）と、`card-cli` の `transactCard` で、同じ `CardWriteRefusedError` を二重に捕まえている。
画面の SSE に知らせるための `onWrite` も、呼ぶ者がいないまま残っている。

画面はいずれゼロから作り直す（ADR 0017）。そのときも拒否のルールをそのまま使えるよう、ルールを CLI の外へ出しておく。

### What Changes

- 提出と保留を、拒否の検査を持つ別々の usecase（`submitReviewCommand` / `holdReviewCommand`）にする。どちらも `kind` を中で固定する。拒否は discriminated union のエラーで返す
- `card-cli` の依存から `appendReviewCommand` を外し、提出と保留の usecase だけを渡す
- `decide` の拒否の検査を、`Board` を受けて `Result` を返す純関数にする
- 書き込みの包み方を 1 つの関数にまとめ、`createTransactionalCardDependencies` と `onWrite` を消す。`decide` は検査から書き込みまでを `transact` の中で走らせる
- `src/` のコメントとテスト名から、画面やサーバが今もあるとする記述を消すか、今の使い手（`ai-board` の CLI）に合わせて書き直す
- 画面のためだけに残ったコード（`moveTargetFor` / `applyMove` / `MoveTarget`、`createTransactionalCardDependencies`、`onWrite`）を消す
- CLI の出力（標準出力・標準エラーの文・終了コード）とコミットのメッセージは変えない（`DECIDE_USAGE` の 1 行を除く）

### Impact

- カード: `src/cards/usecases/commands/`（提出と保留の usecase を足す）、`src/cards/errors/card-errors.ts`、`src/cards/composition.ts`、`src/cards/cli/card-cli.ts`、
  `src/cards/repositories/file-card.repository.ts` / `file-idea-divider.repository.ts`（`onWrite` を消す）
- ボード: `src/board/services/decision-guards.ts`（新しい純関数）、`src/board/cli/decide-cli.ts`、`src/cli-main.ts`
- テスト: `src/cards/usecases/__tests__/`、`src/board/services/__tests__/`、`src/board/cli/__tests__/decide-cli.test.ts`、`src/cards/cli/__tests__/card-cli.test.ts`、
  `src/cards/repositories/__tests__/file-idea-divider.repository.test.ts`
- ドキュメント: `CLAUDE.md`、`docs/architecture.md`、`docs/adr/0006-ai-review-entries-and-hold.md`
- 記述の掃除: `src/` の `cards/`・`board/`・`shared/`・`infrastructure/`・`cli-main.ts` と、そのテストのコメントとテスト名
- 画面のためだけに残ったコードの削除: `src/shared/card-reorder.ts` の `moveTargetFor` / `applyMove` / `MoveTarget` と、そのテスト（`createTransactionalCardDependencies` と `onWrite` は節 3 で消す）
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
- **画面のためだけに残ったコードを消す。** 消すのは、CLI の入口（`src/cli.ts` / `src/cli-main.ts`）から宣言の参照をたどって届かず、かつ画面とサーバとダッシュボードを外す前（`054c29f`）に、外したファイルから参照されていたものである。
  当てはまるのは、`src/shared/card-reorder.ts` の `moveTargetFor` / `applyMove` / `MoveTarget`（画面のドラッグでの並べ替え）と、節 3 で消す `createTransactionalCardDependencies` / `onWrite` だけだった。
  `card-reorder.ts` には `DIVIDER_ID` だけが残る。`DIVIDER_ID` の置き場所は変えない。`src/shared/__tests__/card-reorder.test.ts` の `moveTargetFor` / `applyMove` のテストも消す
- **`src/` 全体の、画面やサーバを前提にした記述を今の形に直す。** 探す語は `サーバ` / `画面` / `UI` / `HTTP API` / `/api/` / `SSE` / `web` で、直し方は次のとおりにする。
  - 画面やサーバが今もあるとする記述は、今の使い手（`status` / `decide` / `card` / `loop` の CLI）に合わせて書き直す。要らなくなった記述は消す。
    例: `card-cli` の「UI と HTTP API からだけ行える」は「`ai-board decide` からだけ書く」に、`DECIDE_USAGE` の「画面で押せない判断は拒む」は「出せない判断は拒む」に直す
  - 制約の理由が画面にしかなかったものは、理由の記述だけを直し、制約そのもの（コード）は変えない。
    例: `src/shared/` の「web からも読むので、サーバの型を import しない」
  - 無いファイルや無いエンドポイントを指す記述は、今ある照合先に直すか、消す。
    例: `plan-task.ts` の `src/shared/markdown.ts`、`append-review.command.ts` の「次の `GET /api/board`」
  - テスト名も同じ方針で直す。期待値と fixture の文字列は変えない。
    例: `status-cli.test.ts` の `not.toContain('サーバ:')`、`claude-settings.test.ts` の `curl http://127.0.0.1:5673/api/cards`
  - 画面やサーバのために書いたが、今も CLI の同時の実行に効いているコードは消さず、記述だけを直す。
    例: `file-card.repository.ts` の `readLogFiles` が消えたファイルを読み飛ばすこと（`status` もロックを取らずに読む）、`file-mr-snapshot.repository.ts` の一時ファイルを経た書き込み（`status` が 2 つ同時に走りうる）
  - `docs/` と `.claude/` は、この掃除の対象にしない。タスク 4 で挙げる箇所だけを直す

### 仮定

- **`transact` の中でボードを導いても、自分を待って止まらず、GitHub にも問い合わせない。** 根拠: `getBoardQuery` は、カードと区切り線と `loop/` をデータのワークツリーのファイルから読み、計画は `plansDir`、PR の状態は `refresh()` 済みの `MrStateProvider` の手元の値から読む。
  PR 番号の書き戻し（`writeMr` の `transact`）が走るのは `poller.refresh()` の中だけで、それは `runDecide` が `transact` の前に 1 回呼ぶ（`src/cli-main.ts` の `assembleBoard`、`src/infrastructure/forge-poller.ts`）。
  実装の最初で `get-board.query.ts` を読み直して確かめる。外れていたら、検査を `transact` の外に置いたままにする代案へ戻し、計画に書き残す
- **`transact` の `op` が受け取る `dataDir` は、`store.dataDir` と同じ場所である。** そのため、`createFileCardDependencies(store.dataDir)` で組んだリポジトリを `op` の中で使ってよい。根拠: 今の `card-cli` と `createTransactionalCardDependencies` が同じ形で使っている
- **ADR は 0006 の 1 行を直すだけにする。** 0006 の「CLI は構造でこれを強制する」を、提出と保留の usecase と `card-cli` の依存の絞り込みで強制する、という今の形に直す。
  ADR 0010 の「取り直して検査からやり直す」は、`decide` がこの変更でようやく守る側に入るので、書き直さない。新しい ADR は立てない。判断の中身（AI と人の境界、検査を `transact` の中に置くこと）は既存の ADR のままだからである
- **手順書（`.claude/`）の振る舞いは変わらないので、`.claude/HARNESS_VERSIONS.md` の版は上げない。** CLI の引数と出力が変わらないためである
- **CLI の出力の文は変えない。** 既存の `card-cli.test.ts` / `decide-cli.test.ts` の期待をそのまま通すことで確かめる。
  ただし、`DECIDE_USAGE` の「画面で押せない判断は拒む」は、記述の掃除で「出せない判断は拒む」に直す。使い方の文が変わるのはこの 1 行だけである
- **掃除する記述は、コメントとテスト名だけである。** 根拠: `grep -rnE "サーバ|画面|HTTP API|/api/|SSE|UI " src` で出た 39 ファイルの行を読むと、コードに当たるのは次の 3 種類だけだった。
  - テストの期待値（`not.toContain('サーバ:')`）
  - テストの fixture（`curl .../api/cards`、`card-files.test.ts` の本文の「画面」）
  - 語の取り違え（`pr-checks.ts` の `PASSED_CONCLUSIONS` の `SSE`）

  どれも直さない

### 退けた代案

- **`appendReviewCommand` に `kind` ごとの拒否を足す** — AI と人の境界が、構造ではなく引数の値で決まるようになる。人の判断も同じ usecase を通るので、提出の条件が承認に効くかを毎回読み分けることになる
- **`decide` の検査も usecase にする** — 検査は導出済みの `Board` だけで決まり、データを読まない。CLAUDE.md の「区画や判断のロジックは純関数に切り出してテストする」に合わせ、純関数にする
- **`decide` の検査を `transact` の外に置いたまま、ADR 0010 の例外として記録する** — `transact` の中で導き直しても GitHub への問い合わせは増えない（仮定）。そのため、例外を残す理由が無い
- **pr / status / loop の CLI も usecase に出す** — pr は `gh` の薄い包みで、重い `nextCheckStep` / `isSettled` はすでに純関数である。status は `buildStatusReport` が純関数で、query もある。loop の書き込みは `writeLoopStart` / `writeLoopFinish` に任せている。層を足しても得るものが無い
- **ブランチの紐付けを専用の usecase にし、`card-cli` から `updateCardMetaCommand` も外す** — `startedAt` / `skipGates` も型の上で書けなくなる利点はある。ただし、この計画の目的（拒否のルールを出す）の外になる（人に判断してほしいこと。今回は入れないと回答を受けた）
- **記述の掃除を別のカードにする** — 人が、この計画で `src/` 全体を掃除すると決めた（plan 否決、2026-11-06）
- **画面のためだけに残った関数を消さず、一覧に挙げるだけにする** — 人が、消して欲しいと決めた（plan 否決、2026-11-06）
- **画面と関係なく使われていない export（`isOk` / `createMergeRequestIid` / テストからしか使われない `parseCard` など）も消す** — 画面のために残ったものではなく、頼まれた範囲の外になる（Non-Goals）

### Risks / Trade-offs

- 使う側が CLI だけなので、usecase と純関数を足した分だけ読む場所が増える。拒否のルールは「提出・保留は usecase」「人の判断は `decision-guards.ts`」の 2 か所にまとまる
- `decide` が拒むとき、今はロックと取り直しの前に拒んでいた。この変更の後は、ロックを取り、取り直してから拒む。ロックの待ちの分だけ遅くなりうるが、`card submit` / `card hold` と同じ扱いになる
- `transact` の中でボードを導くので、push が拒否されるたびに導出が 1 回増える。導出はファイルを読むだけで、`transact` のやり直しは 3 回までである
- 記述の掃除は 39 ファイルほどに及び、差分が広がる。記述の掃除ではコードを変えないので、壊れ方は品質ゲート（型・lint・テスト）で拾える。
  読む人の負担を減らすため、掃除は節 5・6 に分け、usecase の切り出し（節 1〜3）とは別のコミットにする

### Non-Goals

- 画面と関係なく使われていない export の削除（`isOk` / `createMergeRequestIid` / `parseCard` など）
- `docs/` と `.claude/` の、画面やサーバを前提にした記述の掃除（タスク 4 の箇所だけを直す）
- `src/shared/` のファイルを、ほかのコンテキストへ移すこと
- ブランチの紐付けの専用の usecase
- pr / status / loop の CLI の組み替え
- CLI の引数・出力・終了コードの変更

## 探索メモとの対応

| #   | 探索メモ                                                                                                                                                                                                                            | 反映した先                                                                                                 | 反映しなかった理由 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------ |
| 1   | 一緒に直す古いコメント（card-cli の「UI と HTTP API」、decide-cli の「画面のボタンと同じ」、`DECIDE_USAGE`）                                                                                                                        | Decisions（`src/` 全体の記述）／タスク 5                                                                   |                    |
| 2   | 強制する場所が移るので書き直す記述（`CLAUDE.md`、`docs/architecture.md` の 89 行目と 239 行目）                                                                                                                                     | Impact／タスク 4                                                                                           |                    |
| 3   | 使う側が CLI だけなので、層を増やすと遠回りになるのが代償                                                                                                                                                                           | Risks / Trade-offs                                                                                         |                    |
| 4   | plan 否決（2026-11-06）: 「人に判断してほしいことを足して。decide の検査は transact の中へ移す。ブランチの紐付けの usecase は今回入れない。画面やサーバを前提にした古い記述は src 全体を掃除する。保留の理由の必須は CLI に残す。」 | 人に判断してほしいこと／Why／Decisions（`src/` 全体の記述）／退けた代案／Non-Goals／タスク 5・6            |                    |
| 5   | plan 否決（2026-11-06）: 「画面のためだけに残ったコードも消して欲しい。」                                                                                                                                                           | 人に判断してほしいこと／Impact／Decisions（画面のためだけに残ったコード）／退けた代案／Non-Goals／タスク 6 |                    |

## 動作確認の手順

`AI_BOARD_DATA` でスクラッチパッドの試しのデータのワークツリーを指して動かす（`.claude/skills/board-loop/rules.md` の「動かして確かめるとき」）。
GitHub に繋がらない試しのデータでは、`decide` の承認 / 否決 / 中止と着手 / 着手を戻すが拒まれる。そのため、`decide` の手順は `config.yaml` の `github:` をこのリポジトリに向け、`gh` にログインした環境で走らせる。

| 確かめること                                   | コマンド                                                                                             | 期待する結果                                                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 着手していないカードへの提出を今と同じ文で拒む | `card create --title t --id a1` の後に `card submit a1`                                              | 「plan の提出は着手したカードにしかできません（着手は人が指示します）」が出て終了コード 1                                     |
| 着手したカードには提出を書ける                 | `decide start a1` の後に `card submit a1 --reason r`                                                 | `a1` が出て終了コード 0。`card show a1` の `## レビュー` に `plan 提出` が 1 件                                               |
| 否決でないゲートへの保留を今と同じ文で拒む     | 上の続きで `card hold a1 --gate plan --reason r`                                                     | 「保留は plan の最新の判断が否決のときにしか書けません」が出て終了コード 1                                                    |
| `decide` は書いて列の移りを 1 行で出す         | `card create --title t --id a2` の後に `decide start a2`                                             | `a2: 着手 を書きました（アイデア → 計画提案中）` が出て終了コード 0                                                           |
| `decide` は出せない判断を今と同じ文で拒む      | 上の続きで `decide approve a2`                                                                       | 「a2 に 承認 は書けません（今の列: 計画提案中。…）」が出て終了コード 1                                                        |
| コミットのメッセージが変わらない               | `git -C "$S/data" log --format=%s -5`                                                                | `data: a2 の startedAt を変える` など、今と同じ形のメッセージが並ぶ                                                           |
| 画面のためだけに残ったコードが無い             | `grep -rnE "moveTargetFor\|applyMove\|onWrite\|createTransactionalCardDependencies" src`（`$WT` で） | 何も出ない                                                                                                                    |
| 画面やサーバを前提にした記述が残っていない     | `grep -rnE "サーバ\|画面\|HTTP API\|/api/\|SSE\|UI " src`（`$WT` で）                                | 出るのは、仮定に挙げた直さない行（テストの期待値・fixture・`PASSED_CONCLUSIONS`）と、画面の作り直しや外した経緯に触れる行だけ |

## タスク

### 1. 提出と保留を usecase にする

- [x] `src/cards/errors/card-errors.ts` に `SubmitBeforeStart` / `SubmitGateClosed` / `HoldGateNotRejected` と `SubmitReviewError` / `HoldReviewError` を足す
- [x] `src/cards/usecases/commands/submit-review.command.ts` と `hold-review.command.ts` を足す。docstring には、今の `runSubmit` / `runHold` の docstring にある「なぜ拒むか」を移す
- [x] `src/cards/composition.ts` の `CardDependencies` と `assemble` に `submitReviewCommand` / `holdReviewCommand` を足す
- [x] `src/cards/cli/card-cli.ts` の `runSubmit` / `runHold` を新しい usecase に切り替える。`submitRefusal` / `gateRejected` / `Refused` を消し、`describeError` で新しい種を今と同じ文に直す
- [x] `CardCliDependencies.cards` を `Pick` で絞り、`appendReviewCommand` を外す
- [x] `src/cards/usecases/__tests__/` に、提出と保留の usecase のテストを足す。書ける場合、各拒否の種、カードが無い場合、拒んだときに何も追記しないことを確かめる

### 2. decide の検査を純関数にする

- [x] `src/board/services/decision-guards.ts` に `DecideRefusal` と `guardReview` / `guardStartedAt` / `guardSkip` / `guardMove` / `guardMoveDivider` を置く
- [x] `src/board/cli/decide-cli.ts` の各ハンドラを、これらの純関数を呼んで `DecideRefusal` を今と同じ文に直す形にする（この節では、検査はまだ `transact` の外のまま）
- [x] `src/board/services/__tests__/decision-guards.test.ts` に、各関数の通る場合と、各拒否の種のテストを足す

### 3. 書き込みの包み方を 1 つにし、decide の検査を transact の中へ移す

- [x] `src/board/usecases/queries/get-board.query.ts` を読み直し、導出が `transact` を呼ばないこと（仮定）を確かめる
- [x] `src/cards/composition.ts` に `transactCardWrite` を足し、`card-cli` の `transactCard` をこれに置き換える
- [x] `src/board/cli/decide-cli.ts` で、ボードの導出・検査・書き込みを `transactCardWrite` の 1 回の中で走らせる。`DecideCliDependencies` に `store` を足し、コミットのメッセージを今と同じにする
- [x] `src/cli-main.ts` の `runDecide` で、`createFileCardDependencies(store.dataDir)` と `store` を渡す。`createTransactionalCardDependencies` と `describePatch` を消す
- [x] `onWrite` を `createFileCardDependencies` / `FileCardRepository` / `FileIdeaDividerRepository` とそのテストから消す
- [x] `src/board/cli/__tests__/decide-cli.test.ts` を、`op` をそのまま走らせる試しの `store` に切り替える。`transact` の中でカードが変わっていたら（試しの `store` が `op` の前に承認を足す）拒んで何も書かないことと、コミットのメッセージを確かめるテストを足す

### 4. ドキュメントとコメント

- [x] `CLAUDE.md` の「`ai-board card` の CLI はこれを構造で強制している」を、提出と保留の usecase と依存の絞り込みで強制する形に直す
- [x] `docs/architecture.md` の「判断と区画」（`card-cli` が拒む条件）と「書き込み」の 3（`submitRefusal`）を、今の置き場所に直す。`decide` の検査も `transact` の中にあることを書く
- [x] `docs/adr/0006-ai-review-entries-and-hold.md` の「CLI は構造でこれを強制する」を今の形に直す

### 5. 記述の掃除（cards・infrastructure・cli-main）

Decisions の「`src/` 全体の記述」の方針で直す。コードは変えない。

- [x] `src/cli-main.ts` と `src/infrastructure/`（`data-store.ts`、`__tests__/forge-poller.test.ts` のコメント）
- [x] `src/cards/cli/card-cli.ts`、`src/cards/composition.ts`、`src/cards/errors/card-errors.ts`
- [x] `src/cards/usecases/commands/`（`append-review` / `update-card-body` / `move-in-order`）と `src/cards/services/review-log.ts`
- [x] `src/cards/repositories/`（`file-card` / `file-idea-divider` / `idea-divider` / `card-files`）
- [x] 節 1〜3 で足したファイルにも、同じ語が無いことを確かめる

### 6. 記述の掃除と、画面のためだけに残ったコードの削除（board・shared）

記述は Decisions の「`src/` 全体の記述」の方針で直す。コードを変えるのは、画面のためだけに残ったコードを消すところだけにする。

- [x] `src/board/cli/`（`decide-cli.ts` の docstring・`DECIDE_USAGE`・コメント、`status-cli.ts`）と、そのテスト名（`decide-cli.test.ts` / `status-cli.test.ts`）
- [x] `src/board/models/`（`board-card.ts` / `plan-task.ts`）、`src/board/services/`（`stage-resolver.ts` / `next-action.ts`）、`src/board/usecases/queries/get-board.query.ts`
- [x] `src/board/composition.ts` と `src/board/repositories/`（`plan` / `branch-plan` / `mr-snapshot` / `file-mr-snapshot`）
- [x] `src/shared/`（`dashboard-sections` / `card-reorder` / `stage-gates` / `stage-labels` / `pr-feedback` / `loop-step` / `loop-activity` / `schemas/common`）
- [x] `src/shared/card-reorder.ts` から `moveTargetFor` / `applyMove` / `MoveTarget` を消し、`src/shared/__tests__/card-reorder.test.ts` のそれらのテストを消す。`dashboard-sections.ts` の `moveTargetFor` / `applyMove` に触れるコメントも直す
- [x] 動作確認の手順の 2 つの `grep` で、残りが無いことを確かめる

## AI レビュー

- [ ] `src/cards/usecases/commands/update-card-body.command.ts:33` の `createUpdateCardBodyCommand` の docstring に「CLI と API のどちらから書いてもここを通るので、入口ごとに検査を持たない」が残り、今は無い API が書き手として居るように読める（Decisions の「`src/` 全体の記述」の方針と食い違う。探す語に `API` だけの形が無く、grep から漏れた）。「どの CLI から書いてもここを通るので」のように今の使い手に合わせて書き直す。コメントだけで、コードは変えない

### 見送った指摘

- `src/board/cli/status-cli.ts:48` の `status` の使い方の文に「サーバは要りません」が残る。誤りではなく、使い方の文を変えるのは計画の Non-Goals（CLI の出力の変更）に当たるので見送る
- `src/board/cli/decide-cli.ts` の `decide()` は `transact` の `op` の中で `loadBoard` を呼ぶので、計画ファイル名の不正などで出る読み飛ばしの警告（`console.warn`、`src/board/repositories/plan.repository.ts:105` など）が、push が拒否されてやり直すたびに重ねて出る。docstring の「`op` は標準出力にも標準エラーにも書かない」とずれるが、出るのは同じ警告の繰り返しだけで、書く中身は変わらないので見送る
- `src/board/cli/decide-cli.ts` の `StageMismatch` の文に使う操作の名前（`label`）を、`reportWrite` → `describeDecideError` → `describeRefusal` へ既定値 `''` の引数で渡している。今 `StageMismatch` が出るのは `runStartedAt` だけで、そこは `label` を渡しているので振る舞いは正しい。渡し方の好みなので見送る
- `src/cards/usecases/commands/submit-review.command.ts` と `hold-review.command.ts` は、どちらも中で `createAppendReviewCommand(cardRepository)` を組み、`gateStates(parseReviewLog(card.body), card.skipGates)[gate]` を同じ形で書いている。中で組むのは計画の Decisions どおりで、重なりは振る舞いを変えない整理なので見送る

### 人に判断してほしいこと

- `src/board/services/next-action.ts:103` の `HOLD_REASONS.draftReverted` の止まりの理由は「下の判断のボタンで計画から立て直させるか中止してください」のままで、今は無い画面のボタンを人に案内する。この文は `status` の判断待ちに、人が何をすればよいか（`hold.reason`、`src/board/cli/status-cli.ts:356`）として出て、`board-decide` が人に伝える。直すなら「`ai-board decide reject` / `abort` で」のように書き換えるが、計画の Non-Goals の「CLI の出力の変更」に踏み込む（探す語に `ボタン` が無く、仮定の「掃除する記述はコメントとテスト名だけ」の洗い出しから漏れた）。この PR で文を直すか、別のカードにするかは人が決める
