# GitHub に届かない研修の環境で、カードと判断を手元の commit だけで書く手元モード

## 人に判断してほしいこと

- `ai-board init`（空のデータ用ブランチを作る）を、手元モードの対象に入れるか。既定: 入れない。`init` は今どおり `origin` に問い合わせて push する。研修では、GitHub に届くうちに fork と clone を済ませておく前提にする
- 既定のモードで、`origin` より先の commit が手元にあるときに読み書きを止める守りは、手元モードを使っていなくても効く。書き込みの commit の後、push の前にプロセスが落ちたときなどに残った commit も、今は次の取り直しで黙って捨てているが、この変更の後は止めて知らせる。この振る舞いの変化を入れてよいか。既定: 入れる（手元モードの commit と見分ける印を持たないため。止めたときの文に、捨てる手順も書く）
- `status` などの出力に、手元モードで動いていることを出すか。既定: 出さない（読み書きの振る舞いだけを変える。出すなら別のカードにする）

既定と違う答えは、plan 承認の理由ではなく plan 差し戻しの理由で返してください。plan 承認は、回答の無い項目をすべて既定のまま進めると読みます。

## 提案

### Why

研修は、オフライン（GitHub に届かない環境）を前提に回せるようにしたい。
今の CLI は、データ用ブランチの書き込みの前に fetch し、書いた後に push する。fetch に失敗すると書き込みを止める（`DataStoreFetchFailed`）。
そのため GitHub に届かないと、カードの起票・本文・提出・保留、人の判断、ループの 1 手の記録がすべて失敗する。
fetch と push を外すだけでも足りない。読み書きのたびに手元を `origin/ai-board/data` へ `reset --hard` で戻すので、次のコマンドで書いたものが消える。

研修は 1 台の Mac で完結し、同じ Mac の中のワークツリーはどれも同じ `.ai-board/data/` とロック（`data.lock`）を使う。
push が担っている「ほかの環境に渡す」と「同時に書いたときに 1 つだけ通す」は要らない。

### What Changes

- **環境変数 `AI_BOARD_DATA_MODE=local` で手元モードにする。** 手元モードでは、データ用ブランチの読み書きで `origin` に触れない
  - 読み出し: fetch せず、手元の `HEAD` に揃えて読む（今の `origin` の無いデータのワークツリーと同じ道）
  - 書き込み: ロック → 手元の `HEAD` に揃える → 検査して書く → commit で終える。push しない
  - データのワークツリーがまだ無いとき: `origin` に問い合わせず、手元のデータ用ブランチ（無ければ最後に取った `origin/ai-board/data`）から作る
- **既定のモードは今のまま。** 書き込みのたびに fetch と push をする。クラウドのセッションやスマホから回す使い方は変えない
- **既定のモードに戻したときに、手元の commit を黙って消さない。** 取り直しで fetch した後、`origin/ai-board/data` に無い commit が手元の `HEAD` にあれば、読み書きを止めて知らせる（`DataStoreLocalAhead`）。
  知らせる文には、`origin` に上げる手順・捨てる手順・手元モードで続ける手順を書く
- `origin` に上げる CLI の操作（`ai-board data push` など）は入れない。要るときに足す

### Impact

- データストア: `src/infrastructure/data-store.ts`（モードの指定、取り直し、ワークツリーの作り方、守り、エラーの種）
- 設定: `src/shared/config.ts`（`resolvePaths` が `AI_BOARD_DATA_MODE` を読む）、`src/cards/composition.ts`（`createBoardDataStore` がモードを渡す）
- エラーの文: `src/cards/cli/data-store-messages.ts`（`init-cli.ts` は `default` で `describeDataStoreError` に渡すので変えない）
- テスト: `src/infrastructure/__tests__/data-store.test.ts`、`src/shared/__tests__/config.test.ts`
- ドキュメント: `docs/adr/0010-cards-on-data-branch.md`、`docs/architecture.md`、`README.md`
- データ用ブランチの形（`ai-board-data.yaml` の版）は変えない。ステージの導出（`stage-resolver.ts`）にも触らない

## 設計

### Decisions

#### モードの持ち方

- `BoardPaths` に `dataMode: 'sync' | 'local'` を足す。`resolvePaths` が `AI_BOARD_DATA_MODE` を読み、`local` なら `local`、空か未設定なら `sync` にする
- それ以外の値は、`[ai-board] AI_BOARD_DATA_MODE の値 <値> は使えません。既定（sync）で動きます` を警告して `sync` にする
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
  `データのワークツリー（<dataDir>）に、origin の ai-board/data に無い commit が <count> 件あるため、読み書きを止めました。手元モード（AI_BOARD_DATA_MODE=local）で書いたものなら、上げるには git -C <dataDir> push origin HEAD:ai-board/data、捨てるには git -C <dataDir> reset --hard origin/ai-board/data を人が走らせてください。手元モードで続けるなら AI_BOARD_DATA_MODE=local を付けて走らせてください`

#### データのワークツリーを作る（`prepare` → `addWorktree`）

- 手元モードでは、`ls-remote` と fetch をしない
- 手元のデータ用ブランチ `refs/heads/ai-board/data` があれば、それで `git worktree add` する（今どおり）
- 無ければ、最後に取った `refs/remotes/origin/ai-board/data` から `-b ai-board/data` で作る
- どちらも無ければ `DataBranchMissing`

### 仮定

- 手元モードの指定は環境変数 `AI_BOARD_DATA_MODE` に置く。根拠: データ用ブランチの `config.yaml` は根から先に読むので全員に効く（人の答えでここには置かない）。git に載らない `.ai-board/config.yaml` は、データ用ブランチに `config.yaml` があると読まれない（`src/shared/config.ts` の `resolveConfigPath`）。設定はストアを組む前に要るが、`config.yaml` はストアで取り直した後に読む。環境変数は既にある `AI_BOARD_DATA` と並び、`resolvePaths` で読める
- 研修の Claude Code のセッションでは、`.claude/settings.local.json` の `env` に `AI_BOARD_DATA_MODE=local` を書けば、Bash から走らせる `ai-board` のすべてに効く。手順書は変えない
- 手元モードでも、ロック（`data.lock`）・版の確かめ・データ用ブランチ以外を checkout したときの止まり・拒んだ書き込みのファイルの片付けは、今どおりに効かせる（`sync` と `runOperation` の今の道に乗るため）
- 手元モードのコミットのメッセージは今のまま（`data: ...`）。手元モードの印は付けない

### 退けた代案

- **設定を git に載らない `.ai-board/config.yaml` に置く** — データ用ブランチに `config.yaml` があると読まれず、ストアの前に読む順にもならない
- **設定をデータ用ブランチの `config.yaml` に置く** — 全員に効き、クラウドのセッションも push しなくなる（人の答え）
- **データのワークツリーの git config（`ai-board.mode`）に置く** — 消えにくい反面、どこで切り替えたかが見えにくく、`AI_BOARD_DATA` の clone ごとに分かれる
- **fetch に失敗したら自動で手元モードに倒す** — 一時的にネットワークが切れただけで、`origin` と分かれた commit が黙って積もる
- **守りで、手元の commit を `origin` に自動で上げる・rebase する** — 分かれた履歴を検査なしで混ぜることになる（ADR 0010 で rebase を退けた理由と同じ）
- **`origin` に上げる `ai-board data push` を今回入れる** — 人の答え（2026-11-06）で今回は入れない

### Risks / Trade-offs

- 手元モードを付け忘れると、オフラインでは今どおり書き込みが `DataStoreFetchFailed` で失敗する。消えはしない
- 手元モードを付けたままオンラインで使うと、書いたものが `origin` に上がらず、クラウドのセッションやほかの clone から見えない。既定のモードに戻した最初のコマンドで守りが止める
- 既定のモードでも、push の前にプロセスが落ちて残った commit で止まるようになる（人に判断してほしいこと）
- 手元モードの間に `origin` 側も進んでいると、守りで止まった後に人が履歴を混ぜる必要がある。CLI は混ぜない

### Non-Goals

- `origin` に上げる CLI の操作（人の答え。要るときに足す）
- `ai-board init` を手元モードで動かすこと（人に判断してほしいこと）
- 手元モードで動いていることを `status` などに出すこと（人に判断してほしいこと）
- GitHub が未設定のときに `decide` が拒むこと・`next` が null になること（`forge-unset-decide` で扱う）
- 手元の PR の控えでボードを描くこと（`offline-snapshot-view`）、ブランチの計画で計画レビューを立てること（`branch-plan-review`）

## 探索メモとの対応

| #   | 探索メモ（短い引用）                                                                    | 反映した先                              | 反映しなかった理由                 |
| --- | --------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------- |
| 1   | 書き込みは `transact`（ロック → `sync` → 書く → commit → push …）。読み出しも `refresh` | Decisions「取り直し」                   |                                    |
| 2   | `no-origin` のときの `sync` は `discardTo('HEAD')` … この道に乗せられる見込み           | Decisions「取り直し」                   |                                    |
| 3   | 設定の置き場所（`config.yaml` か環境変数か）                                            | 仮定、退けた代案                        |                                    |
| 4   | 手元モードで `status` / `decide` が GitHub に問い合わせるか                             | Non-Goals                               | 人の答えで `forge-unset-decide` へ |
| 5   | 手元モードの間の commit を、後で `origin` に上げる口を今回入れるか                      | Non-Goals、退けた代案                   |                                    |
| 6   | ADR 0010 に、研修用の手元モードを書き足す                                               | タスク 3                                |                                    |
| 7   | `offline-snapshot-view`・`branch-plan-review` と合わせて …                              | Non-Goals                               | それぞれのカードで扱う             |
| 8   | 追加の調べ: `no-origin` の道に乗る。`createBoardDataStore` の 1 か所                    | Decisions「モードの持ち方」「取り直し」 |                                    |
| 9   | 追加の調べ: 既定のモードへ戻すと手元の commit が黙って消える                            | Decisions「守り」                       |                                    |
| 10  | 追加の調べ: `config.yaml` はデータ用ブランチの根から先に読む                            | 仮定                                    |                                    |
| 11  | 追加の調べ: GitHub が接続済みでないと `decide` が拒み `next` が null                    | Non-Goals                               | 人の答えで `forge-unset-decide` へ |
| 12  | 人の答え: このカードは書き込みの手元モードに絞る                                        | Non-Goals                               |                                    |
| 13  | 人の答え: 先の commit があれば止めて知らせる守りだけ。上げる操作は入れない              | Decisions「守り」、Non-Goals            |                                    |
| 14  | 人の答え: 置き場所は計画で AI が決める。データ用ブランチの `config.yaml` には置かない   | 仮定、退けた代案                        |                                    |

## 動作確認の手順

どれも `rules.md` の「動かして確かめるとき」のとおり、スクラッチパッドに bare リポジトリ `$S/origin.git` と、それを `origin` にした clone `$S/data` を作り、`AI_BOARD_DATA="$S/data"` で `init` してから走らせる。共有のカードには書かない。

1. 手元モードで書くと commit だけが残る: `AI_BOARD_DATA_MODE=local AI_BOARD_DATA="$S/data" node dist/cli.js card create --title 試し --id local-one < body.md` → `git -C "$S/data" log -1 --format=%s` がそのカードの commit で、`git -C "$S/origin.git" log ai-board/data --format=%s` には無い
2. 手元モードで書いたものが次のコマンドで消えない: 1 の後に `AI_BOARD_DATA_MODE=local AI_BOARD_DATA="$S/data" node dist/cli.js card list` → `local-one` がある
3. GitHub に届かなくても書ける: `git -C "$S/data" remote set-url origin "$S/missing.git"` の後、手元モードで `card create --id local-two` → 成功する（終わったら URL を戻す）
4. 既定のモードに戻すと止まり、消さない: `AI_BOARD_DATA="$S/data" node dist/cli.js card list` → 終了コードが 0 でなく、`origin の ai-board/data に無い commit が 2 件` の文が出る。`git -C "$S/data" log` に `local-one` / `local-two` の commit が残っている
5. 文の手順で上げれば既定のモードに戻れる: `git -C "$S/data" push origin HEAD:ai-board/data` の後、`AI_BOARD_DATA="$S/data" node dist/cli.js card list` → 成功し、2 枚が見える
6. 既定のモードの振る舞いが変わらない: `npm test` の `data-store.test.ts` の既存のテスト（push・拒否のやり直し・オフラインの失敗）が通る

## タスク

### 1. データストアの手元モードと守り

- [ ] `DataStoreOptions` に `mode`、`RefreshOutcome` に `{ kind: 'local' }` を足し、`sync` を手元モード → `origin` 無し → 既定のモードの順に分ける。`syncForWrite` は `local` を土台 `null` にする
- [ ] 手元モードの `addWorktree` を、`origin` に問い合わせず手元のデータ用ブランチ、無ければ `origin/ai-board/data` の追跡ブランチから作る形にする
- [ ] 既定のモードの取り直しに守りを足す。`DataStoreError` に `DataStoreLocalAhead` を足し、push が拒否された後の取り直しでは数えない
- [ ] `describeDataStoreError` に `DataStoreLocalAhead` を足す
- [ ] `data-store.test.ts` にテストを足す: 手元モードの書き込みが push せず commit だけする / 手元モードで書いたものが次の `refresh` で消えない / `origin` に届かなくても手元モードで書ける / 手元モードで `origin` に触れずにワークツリーを作る / 既定のモードで先の commit があれば `refresh` と `transact` が `DataStoreLocalAhead` で止まり commit を残す / 拒否の後のやり直しは守りで止まらない（既存の 2 つの clone のテストが通ること）

### 2. 環境変数から手元モードを選ぶ

- [ ] `BoardPaths` に `dataMode` を足し、`resolvePaths` が `AI_BOARD_DATA_MODE` を読む。使えない値は警告して `sync` にする
- [ ] `createBoardDataStore` が `paths.dataMode` を `mode` に渡す
- [ ] `config.test.ts` にテストを足す: 未設定 / `local` / 使えない値

### 3. ドキュメントと ADR

- [ ] `docs/adr/0010-cards-on-data-branch.md` に、研修用の手元モードと守りを書き足す（決定・結果・退けた案）
- [ ] `docs/architecture.md` のデータ用ブランチの読み書きの節に、手元モードの取り直し・書き込み・守りを足す
- [ ] `README.md` に、オフラインの研修で手元モードを使う方法（`AI_BOARD_DATA_MODE=local`、`.claude/settings.local.json` の `env`、既定のモードへ戻すときの手順）を足す
