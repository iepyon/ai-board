# 研修で、オンラインとオフライン（手元の commit だけで読み書きする手元モード）を選べるようにする

## 人に判断してほしいこと

- `ai-board init`（空のデータ用ブランチを作る）を、手元モードの対象に入れるか。既定: 入れない。`init` は今どおり `origin` に問い合わせて push する。オフラインで研修するときは、GitHub に届くうちに fork と clone を済ませておく前提にする
  - → 回答（2026-11-06、plan 承認）: 理由なしで承認（既定のまま進む）
- 既定のモードで、`origin` より先の commit が手元にあるときに読み書きを止める守りは、手元モードを使っていなくても効く。書き込みの commit の後、push の前にプロセスが落ちたときなどに残った commit も、今は次の取り直しで黙って捨てているが、この変更の後は止めて知らせる。この振る舞いの変化を入れてよいか。既定: 入れる（手元モードの commit と見分ける印を持たないため。止めたときの文に、捨てる手順も書く）
  - → 回答（2026-11-06、plan 承認）: 理由なしで承認（既定のまま進む）
- `status` などの出力に、手元モードで動いていることを出すか。既定: 出さない（読み書きの振る舞いだけを変える。出すなら別のカードにする）
  - → 回答（2026-11-06、plan 承認）: 理由なしで承認（既定のまま進む）
- モードのファイルを書く CLI（`ai-board data-mode local|sync` など）を足すか。既定: 足さない（人がファイルを 1 行書く。手順は README と止めたときの文に書く）
  - → 回答（2026-11-06、plan 承認）: 理由なしで承認（既定のまま進む）

既定と違う答えは、plan 承認の理由ではなく plan 差し戻しの理由で返してください。plan 承認は、回答の無い項目をすべて既定のまま進めると読みます。

## 提案

### Why

研修は、オンライン（GitHub に届く環境）でもオフライン（届かない環境）でも回せるよう、選択肢を残しておきたい。
今の CLI は、データ用ブランチの書き込みの前に fetch し、書いた後に push する。fetch に失敗すると書き込みを止める（`DataStoreFetchFailed`）。
そのため GitHub に届かないと、カードの起票・本文・提出・保留、人の判断、ループの 1 手の記録がすべて失敗し、オフラインは選べない。
fetch と push を外すだけでも足りない。読み書きのたびに手元を `origin/ai-board/data` へ `reset --hard` で戻すので、次のコマンドで書いたものが消える。

オフラインで研修するときは 1 台の Mac で完結し、同じ Mac の中のワークツリーはどれも同じ `.ai-board/data/` とロック（`data.lock`）を使う。
push が担っている「ほかの環境に渡す」と「同時に書いたときに 1 つだけ通す」は要らない。
オンラインで研修するときは、今の形（書き込みのたびに fetch と push）のまま回せる。

### What Changes

- **ファイル `.ai-board/data-mode.yaml` に `mode: local` と書くと手元モードになる。** ファイルが無い・`mode: sync` なら、今どおりの既定のモードで動く。研修ごとにどちらかを選べる
  - 置き場所はデータのワークツリーの隣（`<dataDir の親>/data-mode.yaml`）。ロック（`data.lock`）と PR の状態の控え（`cache/`）と同じ場所で、git に載らない
- **手元モードでは、データ用ブランチの読み書きで `origin` に触れない**
  - 読み出し: fetch せず、手元の `HEAD` に揃えて読む（今の `origin` の無いデータのワークツリーと同じ道）
  - 書き込み: ロック → 手元の `HEAD` に揃える → 検査して書く → commit で終える。push しない
  - データのワークツリーがまだ無いとき: `origin` に問い合わせず、手元のデータ用ブランチ（無ければ最後に取った `origin/ai-board/data`）から作る
- **既定のモードは今のまま。** 書き込みのたびに fetch と push をする。クラウドのセッションやスマホから回す使い方は変えない
- **既定のモードに戻したときに、手元の commit を黙って消さない。** 取り直しで fetch した後、`origin/ai-board/data` に無い commit が手元の `HEAD` にあれば、読み書きを止めて知らせる（`DataStoreLocalAhead`）。
  知らせる文には、`origin` に上げる手順・捨てる手順・手元モードで続ける手順を書く
- `origin` に上げる CLI の操作（`ai-board data push` など）は入れない。要るときに足す

### Impact

- データストア: `src/infrastructure/data-store.ts`（モードの指定、取り直し、ワークツリーの作り方、守り、エラーの種）
- 設定: `src/shared/config.ts`（`resolvePaths` が `data-mode.yaml` を読む）、`src/cards/composition.ts`（`createBoardDataStore` がモードを渡す）
- エラーの文: `src/cards/cli/data-store-messages.ts`（`init-cli.ts` は `default` で `describeDataStoreError` に渡すので変えない）
- `.gitignore`: `/.ai-board/data-mode.yaml` を足す
- テスト: `src/infrastructure/__tests__/data-store.test.ts`、`src/shared/__tests__/config.test.ts`
- ドキュメント: `docs/adr/0010-cards-on-data-branch.md`、`docs/architecture.md`、`README.md`
- データ用ブランチの形（`ai-board-data.yaml` の版）は変えない。ステージの導出（`stage-resolver.ts`）にも触らない

## 設計

### Decisions

#### モードの持ち方

- モードのファイルは `<dataDir の親>/data-mode.yaml`。中身は `mode: local` か `mode: sync` の 1 行（Zod で検査する）
  - 既定の置き場所では `.ai-board/data-mode.yaml`（リンクされたワークツリーからも、メインのチェックアウトのもの）
  - `AI_BOARD_DATA` で試しの clone（`$S/data`）を指したときは `$S/data-mode.yaml`。試しの書き込みが本物のモードを変えない
- `BoardPaths` に `dataMode: 'sync' | 'local'` を足す。`resolvePaths` がファイルを読み、無ければ `sync` にする
- 読めない・形が違うときは、`[ai-board] <path> を読めないため、既定のモード（sync）で動きます: <理由>` を警告して `sync` にする
  （`sync` に倒しても、オフラインなら書き込みは今どおり失敗し、手元の commit は守りが止めるので、消えはしない）
- `DataStoreOptions` に `mode?: 'sync' | 'local'`（既定 `sync`）を足し、`createBoardDataStore` が `paths.dataMode` を渡す。ストアを組む入口はここ 1 か所なので、`card` / `status` / `decide` / `loop` / `pr` のどれも同じに効く

#### 取り直し（`sync`）

`sync` の分岐を次の順にする。

1. `ensureDataBranchHead`（今どおり。データ用ブランチ以外を checkout していれば止まる）
2. 手元モード: `discardTo('HEAD')` → 版を確かめ、`{ kind: 'local' }` を返す
3. `origin` が無い: 今どおり `discardTo('HEAD')` → `{ kind: 'no-origin' }`
4. 既定のモード: fetch → **守り** → `discardTo(origin/ai-board/data)` → `fetched` / `offline`

- `RefreshOutcome` に `{ kind: 'local' }` を足す。読み出しの呼び出し側は `offline` だけを見て警告するので、変えなくてよい
- `syncForWrite` は `local` を `no-origin` と同じに扱い、土台を `null` にする。`attempt` は土台が `null` なら push を飛ばす（今の分岐のまま）

#### 守り（`DataStoreLocalAhead`）

- 既定のモードで fetch した後（fetch に失敗したときも、最後に取った `origin/ai-board/data` に対して）、`git rev-list --count refs/remotes/origin/ai-board/data..HEAD` を数える。1 以上なら `discardTo` の前に止め、`{ type: 'DataStoreLocalAhead', dataDir, count }` を返す
- push が拒否された後の取り直し（`transact` の 2 回目以降の試み）では数えない。そこで手元にある commit は、その書き込み自身が作って拒否されたもので、捨ててやり直すのが今の決まりだから
- `origin/ai-board/data` の追跡ブランチがまだ無いときは数えない（比べる先が無い。続く `discardTo` が今どおり失敗する）
- 人向けの文（`describeDataStoreError`）:
  `データのワークツリー（<dataDir>）に、origin の ai-board/data に無い commit が <count> 件あるため、読み書きを止めました。手元モードで書いたものなら、上げるには git -C <dataDir> push origin HEAD:ai-board/data、捨てるには git -C <dataDir> reset --hard origin/ai-board/data を人が走らせてください。手元モードで続けるなら <dataDir の親>/data-mode.yaml に mode: local と書いてください`

#### データのワークツリーを作る（`prepare` → `addWorktree`）

- 手元モードでは、`ls-remote` と fetch をしない
- 手元のデータ用ブランチ `refs/heads/ai-board/data` があれば、それで `git worktree add` する（今どおり）
- 無ければ、最後に取った `refs/remotes/origin/ai-board/data` から `-b ai-board/data` で作る
- どちらも無ければ `DataBranchMissing`

### 仮定

- モードのファイルの名前は `data-mode.yaml`、形は YAML の `mode:` の 1 項目にする。根拠: 人の差し戻し（環境変数でなくファイルの書き込みにしたい）。既にある `config.yaml` と同じく YAML にそろえ、後で項目を足せるようにする
- 置き場所はデータのワークツリーの隣（`<dataDir の親>`）にする。根拠: データのワークツリーの中は取り直しの `clean` が追跡していないファイルを消す（`discardTo`）。データ用ブランチの `config.yaml` は全員に効く（人の答えでそこには置かない）。git に載らない `.ai-board/config.yaml` は、データ用ブランチに `config.yaml` があると読まれず（`src/shared/config.ts` の `resolveConfigPath`）、ストアを組んで取り直した後に読む。`<dataDir の親>` はロックと `cache/` の置き場所で、`AI_BOARD_DATA` の試しでも本物と分かれる
- 手元モードでも、ロック（`data.lock`）・版の確かめ・データ用ブランチ以外を checkout したときの止まり・拒んだ書き込みのファイルの片付けは、今どおりに効かせる（`sync` と `runOperation` の今の道に乗るため）
- 手元モードのコミットのメッセージは今のまま（`data: ...`）。手元モードの印は付けない

### 退けた代案

- **環境変数 `AI_BOARD_DATA_MODE` で選ぶ** — plan 差し戻し（2026-11-06）で、ファイルの書き込みにする
- **設定を git に載らない `.ai-board/config.yaml` に置く** — データ用ブランチに `config.yaml` があると読まれず、ストアの前に読む順にもならない
- **設定をデータ用ブランチの `config.yaml` に置く** — 全員に効き、クラウドのセッションも push しなくなる（人の答え）
- **ファイルをデータのワークツリーの中に置く** — 取り直しの `clean` が消す
- **データのワークツリーの git config（`ai-board.mode`）に置く** — どこで切り替えたかが見えにくく、ファイルの書き込みにしたいという差し戻しにも合わない
- **fetch に失敗したら自動で手元モードに倒す** — 一時的にネットワークが切れただけで、`origin` と分かれた commit が黙って積もる。オンラインとオフラインは人が選ぶ
- **守りで、手元の commit を `origin` に自動で上げる・rebase する** — 分かれた履歴を検査なしで混ぜることになる（ADR 0010 で rebase を退けた理由と同じ）
- **`origin` に上げる `ai-board data push` を今回入れる** — 人の答え（2026-11-06）で今回は入れない
- **モードのファイルを書く CLI を足す** — 1 行のファイルで足り、CLI の入口が増える（人に判断してほしいこと）

### Risks / Trade-offs

- オフラインでファイルを書き忘れると、今どおり書き込みが `DataStoreFetchFailed` で失敗する。消えはしない
- 手元モードのままオンラインで使うと、書いたものが `origin` に上がらず、クラウドのセッションやほかの clone から見えない。ファイルを消して既定のモードに戻した最初のコマンドで守りが止める
- 既定のモードでも、push の前にプロセスが落ちて残った commit で止まるようになる（人に判断してほしいこと）
- 手元モードの間に `origin` 側も進んでいると、守りで止まった後に人が履歴を混ぜる必要がある。CLI は混ぜない

### Non-Goals

- `origin` に上げる CLI の操作（人の答え。要るときに足す）
- `ai-board init` を手元モードで動かすこと（人に判断してほしいこと）
- 手元モードで動いていることを `status` などに出すこと（人に判断してほしいこと）
- モードのファイルを書く CLI（人に判断してほしいこと）
- GitHub が未設定のときに `decide` が拒むこと・`next` が null になること（`forge-unset-decide` で扱う）
- 手元の PR の控えでボードを描くこと（`offline-snapshot-view`）、ブランチの計画で計画レビューを立てること（`branch-plan-review`）

## 探索メモとの対応

| #   | 探索メモ（短い引用）                                                                                       | 反映した先                                    | 反映しなかった理由                 |
| --- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------- |
| 1   | 書き込みは `transact`（ロック → `sync` → 書く → commit → push …）。読み出しも `refresh`                    | Decisions「取り直し」                         |                                    |
| 2   | `no-origin` のときの `sync` は `discardTo('HEAD')` … この道に乗せられる見込み                              | Decisions「取り直し」                         |                                    |
| 3   | 設定の置き場所（`config.yaml` か環境変数か）                                                               | Decisions「モードの持ち方」、仮定、退けた代案 |                                    |
| 4   | 手元モードで `status` / `decide` が GitHub に問い合わせるか                                                | Non-Goals                                     | 人の答えで `forge-unset-decide` へ |
| 5   | 手元モードの間の commit を、後で `origin` に上げる口を今回入れるか                                         | Non-Goals、退けた代案                         |                                    |
| 6   | ADR 0010 に、研修用の手元モードを書き足す                                                                  | タスク 3                                      |                                    |
| 7   | `offline-snapshot-view`・`branch-plan-review` と合わせて …                                                 | Non-Goals                                     | それぞれのカードで扱う             |
| 8   | 追加の調べ: `no-origin` の道に乗る。`createBoardDataStore` の 1 か所                                       | Decisions「モードの持ち方」「取り直し」       |                                    |
| 9   | 追加の調べ: 既定のモードへ戻すと手元の commit が黙って消える                                               | Decisions「守り」                             |                                    |
| 10  | 追加の調べ: `config.yaml` はデータ用ブランチの根から先に読む                                               | 仮定                                          |                                    |
| 11  | 追加の調べ: GitHub が接続済みでないと `decide` が拒み `next` が null                                       | Non-Goals                                     | 人の答えで `forge-unset-decide` へ |
| 12  | 人の答え: このカードは書き込みの手元モードに絞る                                                           | Non-Goals                                     |                                    |
| 13  | 人の答え: 先の commit があれば止めて知らせる守りだけ。上げる操作は入れない                                 | Decisions「守り」、Non-Goals                  |                                    |
| 14  | 人の答え: 置き場所は計画で AI が決める。データ用ブランチの `config.yaml` には置かない                      | 仮定、退けた代案                              |                                    |
| 15  | plan 差し戻し（2026-11-06）: 「選択肢を残しておきたい」                                                    | 題、Why、What Changes                         |                                    |
| 16  | plan 差し戻し（2026-11-06）: 「環境変数の渡し方。ファイルの書き込みにしたい」                              | Decisions「モードの持ち方」、仮定、退けた代案 |                                    |
| 17  | 人と決めた（2026-11-06、チャット）: 「選択肢を残しておきたい」は、研修でオンラインもオフラインも選べること | Why、What Changes                             |                                    |

## 動作確認の手順

どれも `rules.md` の「動かして確かめるとき」のとおり、スクラッチパッドの作業用ディレクトリ `$S` に bare リポジトリ `$S/origin.git` と、それを `origin` にした clone `$S/data` を作り、`AI_BOARD_DATA="$S/data"` で `init` してから走らせる。モードのファイルは `$S/data-mode.yaml` になる。共有のカードと本物のモードには触らない。

1. 手元モードで書くと commit だけが残る: `echo 'mode: local' > "$S/data-mode.yaml"` の後、`AI_BOARD_DATA="$S/data" node dist/cli.js card create --title 試し --id local-one < body.md` → `git -C "$S/data" log -1 --format=%s` がそのカードの commit で、`git -C "$S/origin.git" log ai-board/data --format=%s` には無い
2. 手元モードで書いたものが次のコマンドで消えない: 1 の後に `AI_BOARD_DATA="$S/data" node dist/cli.js card list` → `local-one` がある
3. GitHub に届かなくても書ける: `git -C "$S/data" remote set-url origin "$S/missing.git"` の後、`card create --id local-two` → 成功する（終わったら URL を戻す）
4. 既定のモードに戻すと止まり、消さない: `rm "$S/data-mode.yaml"` の後、`AI_BOARD_DATA="$S/data" node dist/cli.js card list` → 終了コードが 0 でなく、`origin の ai-board/data に無い commit が 2 件` の文が出る。`git -C "$S/data" log` に `local-one` / `local-two` の commit が残っている
5. 文の手順で上げれば既定のモードに戻れる: `git -C "$S/data" push origin HEAD:ai-board/data` の後、`AI_BOARD_DATA="$S/data" node dist/cli.js card list` → 成功し、2 枚が見える
6. 読めないファイルは既定のモードに倒す: `echo 'mode: offline' > "$S/data-mode.yaml"` の後、`card list` → 警告が 1 行出て、既定のモードで読む
7. 既定のモードの振る舞いが変わらない: `npm test` の `data-store.test.ts` の既存のテスト（push・拒否のやり直し・オフラインの失敗）が通る

## タスク

### 1. データストアの手元モードと守り

- [x] `DataStoreOptions` に `mode`、`RefreshOutcome` に `{ kind: 'local' }` を足し、`sync` を手元モード → `origin` 無し → 既定のモードの順に分ける。`syncForWrite` は `local` を土台 `null` にする
- [x] 手元モードの `addWorktree` を、`origin` に問い合わせず手元のデータ用ブランチ、無ければ `origin/ai-board/data` の追跡ブランチから作る形にする
- [x] 既定のモードの取り直しに守りを足す。`DataStoreError` に `DataStoreLocalAhead` を足し、push が拒否された後の取り直しでは数えない
- [x] `describeDataStoreError` に `DataStoreLocalAhead` を足す
- [x] `data-store.test.ts` にテストを足す: 手元モードの書き込みが push せず commit だけする / 手元モードで書いたものが次の `refresh` で消えない / `origin` に届かなくても手元モードで書ける / 手元モードで `origin` に触れずにワークツリーを作る / 既定のモードで先の commit があれば `refresh` と `transact` が `DataStoreLocalAhead` で止まり commit を残す / 拒否の後のやり直しは守りで止まらない（既存の 2 つの clone のテストが通ること）

### 2. ファイルから手元モードを選ぶ

- [x] `BoardPaths` に `dataMode` を足し、`resolvePaths` が `<dataDir の親>/data-mode.yaml` を読む（Zod で検査）。無ければ `sync`、読めない・形が違うときは警告して `sync` にする
- [x] `createBoardDataStore` が `paths.dataMode` を `mode` に渡す
- [x] `.gitignore` に `/.ai-board/data-mode.yaml` を足す
- [x] `config.test.ts` にテストを足す: ファイルが無い / `mode: local` / `mode: sync` / 形が違う / `AI_BOARD_DATA` を指したときは指した先の隣のファイルを読む

### 3. ドキュメントと ADR

- [x] `docs/adr/0010-cards-on-data-branch.md` に、研修用の手元モードと守りを書き足す（決定・結果・退けた案）
- [x] `docs/architecture.md` のデータ用ブランチの読み書きの節に、手元モードのファイル・取り直し・書き込み・守りを足す
- [x] `README.md` に、研修でオンラインとオフラインを選ぶ方法（`.ai-board/data-mode.yaml` の書き方、既定のモードへ戻すときの手順）を足す

## AI レビュー

- [x] `src/infrastructure/data-store.ts:310` の `attempt()` で push が通っても、`remote.origin.fetch` が `ai-board/data` を写さない clone（`--single-branch` や `--depth` の clone で、`+refs/heads/main:refs/remotes/origin/main` だけのもの）では `refs/remotes/origin/ai-board/data` が動かない（push で追跡のブランチが動くのは、fetch の refspec が写すときだけ。スクラッチの repo で push の後に `rev-list --count` が 1 になるのを確かめた）。次のコマンドで fetch に失敗すると、`guardLocalAhead()`（:464）が push 済みのコミットを「origin に無い」と数えて `DataStoreLocalAhead` で止まり、この PR の前は警告付きで読めていた既定のモードのオフラインの読み出しが失敗し、文も既に上がったコミットを上げるか捨てるよう促す。push が通ったら `git update-ref refs/remotes/origin/ai-board/data HEAD`（`DATA_REMOTE_REF`）で追跡のブランチを進め、`data-store.test.ts` に「fetch の refspec が ai-board/data を写さない clone で書いた後、fetch に失敗しても refresh が `offline` を返す」テストを足す

### 見送った指摘

- `src/infrastructure/data-store.ts:464` の守りは、`origin` の `ai-board/data` が force-push や `init` のやり直しで書き換えられたときも、ほかの clone の読み書きを止める（文の push の手順は non-fast-forward で拒まれ、reset の手順で抜ける）。`origin` に無いコミットがあれば既定のモードで止めることは、計画の「人に判断してほしいこと」で既定のまま承認された振る舞いで、Risks にも人が履歴を混ぜると書いてあるので見送る
- `src/cli-main.ts:230` の `ai-board pr` は、取り直しが `DataStoreLocalAhead` で失敗しても「読み書きを止めました」と出した後に続けて動く。`pr` は取り直しの失敗で止めない作りで（`runPr` の docstring）、カードに書かず `config.yaml` を読むだけなので見送る
- `src/shared/config.ts:101` の `resolvePaths` が呼ばれるたびに `data-mode.yaml` を読むので、形の違うファイルの警告が `status` / `decide` / `pr` では 2 回出る（`runStatus` と `loadConfig` の 2 か所）。動作確認の手順 6 の `card list` では 1 回で、振る舞いは変わらない見た目の重複なので見送る
- `src/infrastructure/data-store.ts:390` の `addWorktreeLocally` は、`addWorktree` の手元のブランチの確かめ・`worktree prune`・`worktree add` を写している。振る舞いを変えない重複の整理なので見送る
- `src/infrastructure/data-store.ts:431` の `sync()` の手元モードの分岐は、`origin` 無しの分岐と `kind` のほかは同じで、手元モードでも使わない `git remote` を走らせる。振る舞いを変えない整理なので見送る
- `src/infrastructure/data-store.ts:464` の `guardLocalAhead` は、既定のモードの取り直しごとに git を 3 回足して走らせる（`rev-parse` 2 回と `rev-list --count`）。この PR の目的の外の効率の改善なので見送る
- `src/infrastructure/data-store.ts:477` で `rev-list --count` の出力が数でないと `NaN > 0` が偽になり、守りを素通りする。`rev-list --count` は数だけを出し hook も走らないので起きる道が見当たらず、見送る
