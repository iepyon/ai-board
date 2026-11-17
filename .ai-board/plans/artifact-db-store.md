# データ用ブランチをやめ、カードの正本を Artifact の DB に置く

## 提案

### Why

- データ用ブランチ `ai-board/data`（ADR 0010）は、orphan のブランチ・データのワークツリー・ロックと push の楽観ロック・`AI_BOARD_DATA` での試し・`init` での作成・`card export` での持ち出しと、特殊なやり方が重なっている。fork や研修の準備が手間で、仕組みを人に説明しにくい
- 普段の開発は PC とスマホで行い、PC を閉じたままスマホからも直したい。オフラインの研修（手元モード）は要らなくなった
- 置き場所は、あとから SQLite に差し替えられるようにしておきたい

### What Changes

- **カードの正本を、Claude の Artifact の DB に置く。** ボードのページの Artifact（URL は `main` の `.ai-board/config.yaml` の `store.url`）の DB に、カード・判断・並び順・PR の控え・ループの記録を文書として置く
- **CLI は手元の写しを読み、書き込みは「送る箱」に積む。** node の CLI は DB に届かないので、DB との行き来は Claude が `ArtifactData` のツールで行う
  - 取り込み: Claude が `ArtifactData` の `list`（`out_dir`）で DB の文書を手元に書き出し、`ai-board store pull --from <dir>` で写し（`.ai-board/store/mirror/`）に入れる
  - 書き込み: `ai-board card` / `decide` / `loop` / `status` が書く分は、写しを直したうえで送る箱（`.ai-board/store/outbox/`）に、文書ごとの版（`if_version`）付きで積む
  - 送り出し: Claude が `ai-board store outbox --json` の書き込みを `ArtifactData` の `batch` にそのまま渡し、通ったら `ai-board store ack` で箱を空にして取り込み直す。版が食い違ったら箱を捨てて取り込み直し、元のコマンドを頭からやり直す
- **置き場所を 1 つの口（`DocumentStore`）に閉じる。** カードなどのリポジトリはこの口だけを使う。Artifact の DB の実装（写しと送る箱）と、テスト用のメモリの実装を置く。SQLite はこの口の実装を足すだけで差し替えられる
- **データ用ブランチのコードと決まりを外す。** `data-store.ts`・`init` の CLI・手元モード・`AI_BOARD_DATA`・データのワークツリーの deny ルールを消す。データ用ブランチそのものは消さず、移した後は使わない
- **最初のアイデアカードを固定の seed ファイルにする。** `main` の `.ai-board/seed/*.md`（`card seed` が読む形）を、`ai-board store seed` で送る箱に積む。fork や研修は「ページを 1 つ公開して URL を書き、seed を送る」で始められる
- **設定を `main` に置く。** `.ai-board/config.yaml`（`github.repository` と `store.url`）を git に載せる。データ用ブランチへ写す仕組みは消す
- **今のカードを移す。** `ai-board store import --from <データ用ブランチの clone>` で、カード・判断・並び順だけを送る箱に積む。PR の控えは GitHub から引き直し、ループの記録は移さない
- **Claude が DB へ書くのは送る箱の中身だけにする。** `ArtifactData` の書き込みを、送る箱のファイルだけを指すものに限る hook を置く

### Impact

- コード: `src/infrastructure/`（`data-store.ts` を消し、`document-store.ts` と `artifact-mirror-store.ts` を足す）、`src/cards/repositories/`・`src/board/repositories/`（ファイルから文書へ）、`src/cards/cli/`（`init` を消し `store` を足す）、`src/cli-main.ts`、`src/infrastructure/config.ts`
- 設定: `.claude/settings.json`（データ用ブランチの deny を消し、hook を足す）、`.gitignore`（`.ai-board/store/`）、`.ai-board/config.yaml`（git に載せる）、`.ai-board/seed/`
- 手順書: `board-loop`（`rules.md` の読み書き）・`board-decide`・`board-view`、新しい `board-store` のスキル
- ドキュメント: `README.md`・`docs/reference.md`・`CLAUDE.md`、ADR 0010 を「置き換えた」にして新しい ADR、ADR 0014・0019 の書き直し
- 互換: 形の版を 3 に上げる。古い CLI はデータ用ブランチを読み続けるが、移した後に書いたものは見えない

## 仕様の差分

### board-store（`docs/specs/board-store/spec.md`）（新しい仕様）

カードの正本を置く場所と、CLI がそれを読み書きする流れを定める。置き場所は差し替えられる 1 つの口に閉じる。

#### ADDED Requirements

##### Requirement: 正本の置き場所

システムは カード・判断・並び順・マージ済みの PR の控え・ループの記録の正本を、設定で指す 1 つの置き場所に、文書（コレクションと ID で指す JSON）として置かなければならない (MUST)。
置き場所の既定は Artifact の DB とし、URL は `main` の `.ai-board/config.yaml` の `store.url` で指さなければならない (MUST)。
git のブランチに正本を置いては SHALL NOT。
リポジトリ（カード・区切り線・PR の控え・ループの記録）は、置き場所の口（`DocumentStore`）だけを通して読み書きしなければならない (MUST)。

###### Scenario: 設定に置き場所が無い

- **WHEN** `.ai-board/config.yaml` に `store.url` が無い状態で `ai-board status` を走らせる
- **THEN** 置き場所が未設定であることと、設定の仕方を 1 行で伝えて 0 以外で終わる

##### Requirement: 手元の写しを読む

システムは CLI の読み出しを、手元の写し（`.ai-board/store/mirror/`）から行わなければならない (MUST)。
写しは `ai-board store pull --from <dir>` で、`ArtifactData` の `out_dir` が書き出した形（`<collection>/<doc_id>.json`）のディレクトリから丸ごと入れ替えなければならない (MUST)。
送る箱に送っていない書き込みが残っているときは、取り込みを拒まなければならない (MUST)（取り込むと、まだ送っていない書き込みの土台が変わるため）。
写しが無いときは、取り込みを促して 0 以外で終わらなければならない (MUST)。

###### Scenario: 取り込んで読む

- **WHEN** DB の文書を `out_dir` で書き出したディレクトリを `ai-board store pull --from` に渡し、続けて `ai-board card list` を走らせる
- **THEN** 書き出した文書のカードが並ぶ

###### Scenario: 送っていない書き込みがある

- **WHEN** 送る箱が空でないときに `ai-board store pull` を走らせる
- **THEN** 送るか捨てるかを促して 0 以外で終わり、写しは変わらない

##### Requirement: 書き込みを送る箱に積む

システムは CLI の書き込みを、写しを直したうえで、文書ごとの書き込み（set / delete と、写しで読んだ版）として送る箱に積まなければならない (MUST)。
書く前の検査（判断を書けるか、ゲートの状態など）は、写しの最新のカードに対して行わなければならない (MUST)。
`ai-board store outbox --json` は、積んだ書き込みを `ArtifactData` の `batch` の `writes` にそのまま渡せる形（1 回 50 件まで）で出さなければならない (MUST)。
既にある文書への書き込みには、写しで読んだ版を付けなければならない (MUST)。新しい文書の書き込みには版を付けない。
`ai-board store ack` は送る箱を空にし、`ai-board store discard` は送る箱を捨てて写しを積む前に戻さなければならない (MUST)。

###### Scenario: 提出を積む

- **WHEN** 写しを取り込んだ後に `ai-board card submit <id>` を走らせる
- **THEN** 写しのカードは計画レビューを待つ状態になり、送る箱に判断の文書 1 件の新規の書き込みが積まれる

###### Scenario: 版が食い違う

- **WHEN** 送る箱の書き込みを送ったが、その間に別の端末が同じ文書を書いていて版が食い違った
- **THEN** DB には何も書かれず、送る箱を捨てて取り込み直し、元のコマンドを頭から走らせ直すと、最新のカードに対して検査し直される

##### Requirement: 形の版

システムは 置き場所の `board/meta` の文書に形の版を持ち、自分と違う版の写しを読まずに止まらなければならない (MUST)。
この計画で版を 3 とする。

###### Scenario: 版が違う

- **WHEN** 写しの `board/meta` の版が 3 でない
- **THEN** 読まずに、版が違うことを伝えて 0 以外で終わる

##### Requirement: 固定の seed ファイルから起票する

システムは `main` の `.ai-board/seed/*.md`（`card seed --from` が読む形）を、`ai-board store seed` で起票の書き込みとして送る箱に積まなければならない (MUST)。
既にある ID は飛ばし、`rank`・着手・`## レビュー` は書いては SHALL NOT。

###### Scenario: 空の置き場所に seed を入れる

- **WHEN** 空の DB を取り込んだ写しで `ai-board store seed` を走らせ、送る箱を送って取り込み直す
- **THEN** seed のカードがアイデアの列に並ぶ

##### Requirement: データ用ブランチから移す

システムは データ用ブランチの clone を読み、カード・判断・並び順・区切り線を、新しい文書の書き込みとして送る箱に積む `ai-board store import --from <dir>` を提供しなければならない (MUST)。
マージ済みの PR の控えとループの記録は移しては SHALL NOT（控えは GitHub から引き直し、ループの記録は見るためのものだから）。
写しにカードが 1 枚でもあれば、拒まなければならない (MUST)（二重に移さないため）。

###### Scenario: 移す

- **WHEN** 空の DB を取り込んだ写しで、データ用ブランチの clone を `--from` に渡して `ai-board store import` を走らせ、送って取り込み直す
- **THEN** `ai-board card list` の ID・タイトル・並び順・`## レビュー` が、移す前のデータ用ブランチの CLI の出力と一致する

### loop-activity（`docs/specs/loop-activity/spec.md`）

#### MODIFIED Requirements

##### Requirement: ループの 1 手ごとの記録を残す

システムは ループ（`/board-loop` を動かした本筋のセッション）が進めた 1 手ごとに、どのループが・どのカードに・どの手（と段）を・どの作業者（レビューの段で立てたサブエージェント。本筋のセッションが自分で進めた手は無し）で進め、
いつ始めていつ終えたか、結果を、1 件の記録として残さなければならない (MUST)。
記録はカードと同じ置き場所（board-store）に置き、書くたびに送らなければならない (MUST)。クラウドのセッションが片付けられても残り、別の端末のボードからも見えるようにするためである。

記録はカードの属性として持っては SHALL NOT、ステージの導出・止まり・次の一手に使っては SHALL NOT。
置き場所の形の版を上げては SHALL NOT（古い版の CLI がカードを読めなくなり、ループ自身が止まるため）。

記録を書くのはループ（本筋のセッション）だけで、書く口はカードを書けない形でなければならない (MUST)。
開始は、存在しないカードや、今の次の一手の語彙に無い手・段（廃止した手を含む）では拒まなければならない (MUST)。
同じループに終わっていない記録が残っていれば、開始はそれを「途切れた」で閉じてから新しい記録を作らなければならない (MUST)。
終了は、そのループの終わっていない記録を 1 度だけ埋め、終わっていない記録が無いとき・カードが食い違うときは拒まなければならない (MUST)。
終わった記録を書き換えては SHALL NOT。
読めない記録は読み飛ばし、ボード全体を止めては SHALL NOT。

記録を書けなくても、ループは手を進め続けなければならない (MUST)。記録は見るためのもので、本来の作業を止めないためである。

###### Scenario: 1 手を進めて終える

- **WHEN** ループが手の始まりに開始を書き、手を終えて終了を書いた
- **THEN** 記録が 1 件でき、開始と終了の 2 回の書き込みが送る箱を通って置き場所に届き、カードの文書は変わらない

###### Scenario: 終了を書き損ねた

- **WHEN** 同じループが、終了を書かないまま次の手の開始を書いた
- **THEN** 前の記録は「途切れた」で閉じ、新しい記録だけが終わっていない記録になる

###### Scenario: 打ち間違い

- **WHEN** 存在しないカードの開始や、終わっていない記録の無い終了を書こうとした
- **THEN** 拒まれて何も書かれない

### card-gate-skip（`docs/specs/card-gate-skip/spec.md`）

#### MODIFIED Requirements

##### Requirement: ゲートの事前スキップ

システムは カードに事前に宣言されたゲートでは、そのゲートの最新の記録が 提出 または 再提出 のとき、
人の承認と同じく通過済みとして扱わなければならない (MUST)。宣言できるのは人だけとする (MUST)。

宣言があっても、レビューログを見ずに通過済みとしては SHALL NOT。
エントリが無ければそのゲートは未提出のままであり、差し戻し / 保留 / 承認 は宣言の無いゲートと同じく効く。
計画を書く手と人の着手の合図を飛ばさずに、人が読む関所だけを飛ばすためである。

宣言できるのは規定のゲート（`plan`）だけとする。規定外のゲート名の宣言は受け付けては SHALL NOT。
廃止したゲート（`explore` / `verify`）の宣言も受け付けては SHALL NOT。

人が plan ゲートを飛ばす宣言を出し入れする手段を、人の判断の CLI（`ai-board decide skip`）に提供しなければならない (MUST)。
AI エージェントが使う CLI に、宣言を書く手段を設けては SHALL NOT。

###### Scenario: 計画レビューを飛ばしても着手するまではアイデアに留まる

- **WHEN** 着手していないカードが plan ゲートをスキップすると宣言し、レビューの記録が無い
- **THEN** plan ゲートは未提出のままで、ステージは `idea` である

###### Scenario: 計画レビューを飛ばすカードも着手すると計画を書く

- **WHEN** plan ゲートをスキップすると宣言したカードが着手され、レビューの記録が無い
- **THEN** ステージは `planning` になり、AI ループの次の一手は計画を書く手になる

###### Scenario: 計画を提出すると計画レビューを通らずに実装中へ進む

- **WHEN** plan ゲートをスキップすると宣言した着手済みのカードで、計画ファイルが存在し、plan ゲートの最新の記録が 提出 または 再提出 である
- **THEN** plan ゲートは通過済みになり、そのカードは `plan-review` に留まらず `impling` になる

###### Scenario: 計画レビューを飛ばしても人の差し戻しは効く

- **WHEN** plan ゲートをスキップすると宣言したカードで、plan の提出の後に人が plan の差し戻しを記録した
- **THEN** plan ゲートは差し戻し中になり、ステージは `planning` に戻る

###### Scenario: 廃止されたゲートは宣言できない

- **WHEN** `ai-board decide skip <id> --gate explore` か `--gate verify` を走らせる
- **THEN** 使い方の誤りとして拒否され、カードは変更されない

###### Scenario: 廃止されたゲートの宣言がカードの文書に残っている

- **WHEN** 置き場所のカードの文書のスキップ宣言に `explore` か `verify` が含まれている
- **THEN** その値は読むときに落とされ、カードは残りの宣言で読める。警告は出ない

## 設計

### Decisions

**置き場所の口（`src/infrastructure/document-store.ts`）**

- 文書は `{ collection, id, version, data }`。口は次の 2 つだけにする。今の `DataStore`（`refresh` / `transact`）と同じ「読む前に 1 回」「書くのは 1 操作」の形を残し、usecase と `transactCardWrite` の作りを変えない
  - `snapshot(): Result<DocumentSnapshot, StoreError>` — 写しを読む。`DocumentSnapshot` は `get(collection, id)` / `list(collection)` を持つ読み出し専用の値
  - `transact(label, op: (tx) => Result<T, E>)` — `tx` は `get` / `list` / `set` / `delete` を持つ。`op` が Err なら何も積まない。Ok なら、触った文書の書き込みを 1 つの束として積む
- 実装は 2 つ
  - `ArtifactMirrorStore`（`src/infrastructure/artifact-mirror-store.ts`）: 写しは `.ai-board/store/mirror/<collection>/<id>.json`、送る箱は `.ai-board/store/outbox/<連番>.json`（束）と、束が指す文書の本体 `outbox/docs/<連番>-<n>.json`。手元の複数のプロセスはロックファイル（`store.lock`）で 1 列にする（今の `data.lock` の作りを移す）
  - `MemoryDocumentStore`（テスト用）: 同じ口をメモリで持つ。usecase とリポジトリのテストはこれで回す
- 置き場所は `.ai-board/store/` をメインのチェックアウトの下に 1 か所置き、どのワークツリーもそこを見る（今のデータのワークツリーと同じ `sharedBoardDir` の解き方）。試すときは `AI_BOARD_STORE` で別のディレクトリを指す

**文書の形（形の版 3）**

| コレクション | ID                              | 中身                                                                                      |
| ------------ | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `board`      | `meta`                          | `{ version: 3 }`                                                                          |
| `board`      | `order`                         | `{ ranks: { <cardId>: number }, divider: number \| null }`                                |
| `cards`      | `<cardId>`                      | `{ title, created, skipGates, branch, pr, body }`（`body` は `## レビュー` を除いた本文） |
| `log`        | `<cardId>.<時刻>.<gate>.<種別>` | `{ cardId, at, gate, kind, reason }`（着手は gate も kind も `start`）                    |
| `snapshots`  | `<cardId>`                      | マージ済みの PR の控え（今の `snapshots/<id>.json` の中身）                               |
| `loop`       | `<時刻>.<ループの識別子>[-n]`   | ループの 1 手の記録（今の `loop/*.json` の中身）                                          |

- 今のデータ用ブランチの 1 ファイルを 1 文書に写した形にする。判断は今と同じく 1 件 1 文書の追記だけで、書き換えない（ADR 0002 の追記専用を、文書を新規でしか作らないことで保つ）
- 文書の ID は今のファイル名（拡張子を除く）をそのまま使う。どれも `ArtifactData` の `doc_id` に使える文字（英数字と `-._~:@+`）に収まる（`toLogStamp` の時刻もカード ID も ASCII）

**リポジトリ**

- `FileCardRepository` / `FileIdeaDividerRepository` / `FilePrSnapshotRepository` / ループの記録のリポジトリを、`DocumentStore` の上の `DocCardRepository` などに置き換える。`CardRepository` などのインターフェースは変えない
- `card-files.ts` のうち、カードの組み立て（`assembleCard`）・判断の名前の決まり・`order` の読み書きの純関数は、ファイルではなく文書の値を受けるように直して残す。ファイルの読み書きと `card.md` の frontmatter の書き出しは消す
- 開いている PR の控え（今の `cache/pr-snapshots.json`）は、写しではなく `.ai-board/store/cache/` に置き、送らない（今と同じく端末ごとの使い捨て）

**`ai-board store`（`src/cards/cli/store-cli.ts`）**

| サブコマンド          | すること                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `pull --from <dir>`   | `out_dir` の書き出しを検査し（形の版・JSON として読めるか）、写しを丸ごと入れ替える。送る箱が空でなければ拒む       |
| `outbox [--json]`     | 積んだ束を出す。`--json` は `{ batches: [{ writes: [...] }] }`（`writes` は `batch` にそのまま渡せる形、50 件ごと） |
| `ack`                 | 送る箱を空にする（送り終えた後に呼ぶ。続けて取り込み直す）                                                          |
| `discard`             | 送る箱を捨て、写しを積む前に戻す（版の食い違いのとき）                                                              |
| `seed [--from <dir>]` | 既定は `.ai-board/seed/`。`card seed` と同じ検査で、起票の書き込みを積む                                            |
| `import --from <dir>` | データ用ブランチの clone を、今の `card-files.ts` の読み方で読み、新しい文書の書き込みとして積む                    |
| `init`                | 空の置き場所に `board/meta` と空の `board/order` を積む（`ai-board init` の代わり）                                 |

- 写しを積む前に戻すため、送る箱の束に「書く前の文書」も控えておく（`discard` が戻す）
- `card seed`・`card export` は残す（`export` は写しを読む）

**Claude が受け持つ行き来（新しい `board-store` のスキル）**

- 取り込み: `ArtifactData` の `list` を 5 つのコレクションに対して `out_dir` 付きで呼び（`next_cursor` があれば続けて）、`ai-board store pull --from <out_dir>`
- 送り出し: `ai-board store outbox --json` の束ごとに `ArtifactData` の `batch`（`writes` をそのまま渡す）→ 全部通れば `ai-board store ack` → 取り込み直す
- 食い違い（`batch` が版の食い違いで何も書かなかった）: `ai-board store discard` → 取り込み直す → 元のコマンドを頭から走らせ直す（2 回まで。超えたら止まって人に伝える）
- `board-loop` の `rules.md` の「カードの読み書き」・`board-decide`・`board-view` は、`status` の前に取り込み、書き込みの後に送り出す、をこのスキルの手順で行う

**ページ**

- 置き場所の Artifact は、`board-view` のページを `capabilities: { db: {}, user: {} }` 付きで公開したものにする。`board-view` は `store.url` に出し直すので、ボードのページの URL が 1 つに決まる
- `db` の規則は既定（サインインした人が読み、Contributors 以上が書く）のままにする。ページは DB を読まず、今と同じく埋め込んだ `status --json --active` を描く

**書き込みの境界**

- `ai-board card` の構造の境界（AI に許す usecase だけを渡す）はそのまま残る。送る箱に積まれるのは、CLI の検査を通った書き込みだけになる
- `.claude/settings.json` に `ArtifactData` の `PreToolUse` の hook（`scripts/artifact-data-guard.mjs`）を置く。`set` / `update` / `str_replace` / `delete` を拒み、`batch` は全エントリが `file_path` で `.ai-board/store/outbox/docs/` の下を指すときだけ通す。読み出しは通す
- データ用ブランチの deny ルールを消し、`Edit(**/.ai-board/store/**)` を deny に足す

**設定と seed**

- `.ai-board/config.yaml` を git に載せる。`github.repository` と `store.url`。`config.example.yaml` は消し、README で 2 行を書き換える手順にする
- `.ai-board/seed/` に、README のチュートリアルで使う題材のカード（`status-stage-counts`）を 1 枚置く

**消すもの**

- `src/infrastructure/data-store.ts`・`data-store-messages.ts`（の data-store の部分）・`src/cards/cli/init-cli.ts`・`config.ts` の `DATA_ENV` / `DATA_MODE_FILE` / `readDataMode`・`transact-card-write.ts` の `DataStore` への依存・それぞれのテスト
- `README.md`・`docs/reference.md` のデータ用ブランチ・手元モード・`init` の節

### 仮定

- `ArtifactData` の `out_dir` は `<out_dir>/<collection>/<doc_id>.json` に、版（`version`）と中身が読める JSON を書く（ツールの説明による）。版を中身と同じファイルから読めないときは、節 1 の最初のタスクで確かめ、`pull` の読み方を合わせる
- `ArtifactData` の `batch` は、版を付けたエントリがあれば全部か無しかで書く（ツールの説明による）。束を 50 件で分けると、束をまたいだ全部か無しかは保てない。今の書き込みは 1 操作で 50 件を超えない（`import` と `seed` だけが超え、どちらも新規の文書なので途中で止まっても `import` / `seed` を走らせ直せば足りない分だけを積む）
- node の CLI から DB へ直接届く手段は使わない（Claude の `ArtifactData` のツールとページの口しか公開されていない）
- 写しの古さは、`status` の前に取り込む手順で抑える。取り込みを忘れた古い写しへの書き込みは、送るときの版の食い違いで止まる（新しい文書の書き込みは食い違わないので、判断の追記は古い写しを土台にしても重ならない）
- ループの記録（ADR 0014）は残す。書くたびに送り出しが要るので、1 手あたり `batch` が 2 回増える
- 今の `ai-board/data` は消さず、移した後は読まない（戻すときの控えにする）

### 退けた代案

- **データ用ブランチの 1 ファイルを 1 文書（`{ path, content }`）にして、今のリポジトリをそのまま使う** — 変更は小さいが、SQLite へ差し替えるときにファイルの形を引きずり、ページから読むにも `card.md` を解かなければならない
- **CLI が DB の API を直接呼ぶ（OAuth のトークンを使う）** — 公開された口ではなく、トークンを扱うことになる（GitHub のトークンを扱わない決まりと同じ理由）
- **CLI を通さず、Claude が `ArtifactData` で直接カードを書く** — 書く前の検査と、AI に許す書き込みだけを渡す構造（`ai-board card`）が無くなる
- **ページの `artifact` の能力（ページ自身を書き直す）に正本を埋め込む** — 書き手が 1 人ずつで、版の食い違いのたびにページ全体を書き直すことになる。Claude からも読み書きしにくい
- **SQLite を今入れる** — 人が Artifact の DB を選んだ。口だけを用意し、実装は足さない（人に判断してほしいこと）
- **スマホのページから判断や本文を直接書けるようにする** — この計画では置き場所の差し替えに絞る。ページの書き込みは、ページでの検査（判断の出し方の純関数をページで動かす）と、AI と人の書き込みの見分けを決める別のカードにする（人に判断してほしいこと）
- **`github.repository` を `origin` の URL から推して設定を要らなくする** — クラウドのセッションでは `origin` が代理の URL になる。fork では 2 行を書き換えるだけにする

### Risks / Trade-offs

- **書き込みのたびに Claude のツールの呼び出しが要る。** 人が端末で `ai-board decide` を打っても送る箱に積まれるだけで、Claude に送り出しを頼むまで DB に届かない。端末だけでは使えない
- **AI と人の書き込みの境界の一部が、hook と手順書になる。** `ai-board card` の構造は残るが、送る箱を通る `decide` と `card` の書き込みは DB の側で見分けられない。`ai-board decide` が誰でも呼べるのは今と同じ
- **写しの古さ。** 取り込みを忘れると古いボードで次の一手を選ぶ。食い違いは送るときに止まるが、新しい文書の追記（判断）は止まらない
- **判断の履歴が git に残らない。** 判断の文書は残るが、誰がいつ DB を書いたかのコミットは無い。DB を壊したときの戻し先は、移した時点のデータ用ブランチだけになる
- **claude.ai への依存。** ボードを使う人は全員 claude.ai のアカウントと、Artifact の共有が要る。DB の容量と回数の上限は相手次第
- **変更が大きい。** `data-store.ts`（936 行）と `card-files.ts`（704 行）を作り直す。リポジトリのインターフェースと usecase を変えないことで、ステージの導出と判断の検査には触らない

### Non-Goals

- SQLite の実装（口だけを用意する）（人に判断してほしいこと）
- スマホのページから判断・本文の編集・並べ替えを書くこと（人に判断してほしいこと）
- ページが DB を読んで開いたまま新しくなること（`board-view` は今と同じく埋め込みで描く）（人に判断してほしいこと）
- データ用ブランチ `ai-board/data` を消すこと（人に判断してほしいこと）
- ステージの導出（`stage-resolver.ts`）と判断の検査の変更

## 動作確認の手順

1. `npm run typecheck && npm run lint && npm run format:check && npm test` が通る
2. スクラッチの置き場所（`AI_BOARD_STORE=<scratch>/store`）で `node dist/cli.js store init` → `store outbox --json` を見て、`board/meta` と `board/order` の新規の書き込みが出る
3. 2 の後に `store ack` し、`board/meta` と `board/order` の JSON を手で置いた `out_dir` 形のディレクトリを `store pull --from` に渡して、`card list` が空の配列を出す
4. 3 の後に `store seed` → `store outbox --json` で `status-stage-counts` の起票の書き込みが 1 件出て、`card list` にそのカードが出る
5. 写しにカードがある状態で `store pull` を走らせると、送る箱が空でないので拒まれて 1 で終わる
6. `AI_BOARD_STORE` を指したまま、データ用ブランチの clone（`git clone --single-branch -b ai-board/data`）を `store import --from` に渡し、`card list` の ID・タイトル・並び順が、移す前の CLI の `card list` と一致する
7. hook のスクリプトに、`ArtifactData` の `set` と、`outbox/docs/` の外を指す `batch` を渡すと拒み、`outbox/docs/` を指す `batch` と `list` は通す
8. （AI が動かせない。人と Claude で行う）スクラッチの Artifact を `db` 付きで公開し、`board-store` のスキルの手順で `store init` を送り、`seed` を送り、取り込み直して `status` にアイデアが 1 枚出る
9. （AI が動かせない。人の依頼で行う）本物の置き場所の Artifact を公開して `store.url` を書き、`store import` で今のカードを移し、`status` の判断待ち・AI 作業中・アイデアの件数が移す前と一致する

## タスク

### 1. 置き場所の口と、写しと送る箱

- [ ] スクラッチの Artifact（`db` 付き）で、`ArtifactData` の `out_dir` が書く JSON の形（版と中身の位置）と、`batch` の `file_path` の扱いを確かめ、`### 仮定` と違えば計画を直す
- [ ] `src/infrastructure/document-store.ts` に口（`DocumentStore`・`DocumentSnapshot`・`DocumentTx`・`StoreError`）と `MemoryDocumentStore` を置く
- [ ] `src/infrastructure/artifact-mirror-store.ts` に写し・送る箱・ロック・`pull` / `outbox` / `ack` / `discard` の読み書きを置く
- [ ] `src/infrastructure/store-messages.ts` に `StoreError` を人に読める 1 行へ変える presenter を置く
- [ ] 口の 2 つの実装に同じテスト（取り込み・積む・版の付け方・捨てて戻す・送る箱があるときの取り込みの拒否・形の版の食い違い）を当てる

### 2. リポジトリを文書の上に置き換える

- [ ] `card-files.ts` を文書の値の純関数に直す（`assembleCard`・判断の文書の ID・`order` の形）
- [ ] `DocCardRepository`・`DocIdeaDividerRepository` を置き、`FileCardRepository`・`FileIdeaDividerRepository` を消す
- [ ] PR の控えとループの記録のリポジトリを文書の上に置き換える（開いている PR の控えは `.ai-board/store/cache/`）
- [ ] リポジトリのテストを `MemoryDocumentStore` で書き直す

### 3. CLI を新しい置き場所で組む

- [ ] `config.ts` に `store.url` を足し、`AI_BOARD_STORE` で置き場所を指せるようにする。`DATA_ENV`・`DATA_MODE_FILE`・`readDataMode` を消す
- [ ] `src/cards/composition.ts`・`src/board/composition.ts`・`transact-card-write.ts`・`createTransactionalPrWriter` を `DocumentStore` で組む
- [ ] `src/cli-main.ts` の `card` / `decide` / `loop` / `status` / `pr` を新しい置き場所で組み、写しが無い・置き場所が未設定のときの 1 行を出す
- [ ] `src/cards/cli/store-cli.ts` に `pull` / `outbox` / `ack` / `discard` / `init` / `seed` / `import` を置き、`run*Cli` のテストを書く
- [ ] `init-cli.ts`・`data-store.ts`・データ用ブランチ向けの `data-store-messages.ts` とそれぞれのテストを消す
- [ ] 仕様の差分を `docs/specs/board-store/spec.md` に写す
- [ ] 仕様の差分を `docs/specs/loop-activity/spec.md` に写す
- [ ] 仕様の差分を `docs/specs/card-gate-skip/spec.md` に写す

### 4. 設定・seed・書き込みの守り

- [ ] `.ai-board/config.yaml`（`github.repository` と `store.url` の空欄）を git に載せ、`config.example.yaml` を消し、`.gitignore` に `.ai-board/store/` を足す
- [ ] `.ai-board/seed/status-stage-counts.md` を置く
- [ ] `scripts/artifact-data-guard.mjs` と `.claude/settings.json` の hook を置き、データ用ブランチの deny を消して `.ai-board/store/` の deny を足す。`src/__tests__/claude-settings.test.ts` を直し、hook のスクリプトのテストを足す

### 5. 手順書とドキュメント

- [ ] `.claude/skills/board-store/SKILL.md`（取り込み・送り出し・食い違い・最初の用意）を書く
- [ ] `board-loop`（`rules.md` の「カードの読み書き」と「動かして確かめるとき」、`SKILL.md` の手順 1）・`board-decide`・`board-view`（`store.url` に `db` 付きで出し直す）を直す
- [ ] `README.md`（fork して準備する手順）・`docs/reference.md`・`CLAUDE.md`（データ用ブランチの節と書き込み境界の表）を直す
- [ ] `adr` のスキルで新しい ADR（カードの正本を Artifact の DB に置き、置き場所の口に閉じる）を書き、ADR 0010 を「置き換えた」にし、ADR 0014・0019 を今の形に書き直す

## 探索メモとの対応

| #   | 探索メモ（短い引用）                                                                        | 反映した先                                                            | 反映しなかった理由 |
| --- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------ |
| 1   | 困っているのは、fork や研修の準備と、データ用ブランチという特殊な持ち方。スマホでも直したい | 提案 / Why、設計 / 設定と seed、設計 / ページ、Non-Goals、タスク 4・5 |                    |
| 2   | スマホで触るとき、PC は閉じたままにしたい。オフラインの研修は要らない                       | 設計 / 消すもの（手元モード）、Risks / Trade-offs                     |                    |
| 3   | データ用ブランチはやめて、正本は Artifact の DB。あとから SQLite に切り替え                 | 設計 / 置き場所の口、仕様の差分 / board-store                         |                    |
| 4   | 最初のアイデアカードは、固定の seed ファイルでよい                                          | 設計 / 設定と seed、仕様の差分 / board-store、タスク 4                |                    |

## 人に判断してほしいこと

- **スマホのページから判断・本文の編集・並べ替えを書くことと、ページが DB を読んで開いたまま新しくなることを、この計画に入れるか。** 既定: どちらも入れない。この計画は置き場所の差し替えに絞り、ページからの書き込みは別のカードにする（ページで判断の検査をどう動かすかと、AI と人の書き込みの見分けを別に決めるため）。それまでスマホからは、今と同じくクラウドのセッションのチャットで頼む
- **SQLite の実装をこの計画に入れるか。** 既定: 入れない。口（`DocumentStore`）とテスト用のメモリの実装だけを置く
- **データ用ブランチ `ai-board/data` を、移した後に消すか。** 既定: 消さずに残し、戻すときの控えにする
- **ループの 1 手の記録（ADR 0014）を残すか。** 既定: 残す。ただし 1 手ごとに送り出しが 2 回増える。外すなら `ai-board loop` と `loop/` の文書もこの計画で消す
- **最初の seed のカードを何枚置くか。** 既定: README のチュートリアルの題材 `status-stage-counts` の 1 枚だけ
