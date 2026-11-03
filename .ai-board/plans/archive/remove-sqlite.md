# SQLite への依存をコードから消す

## 提案

### Why

カードの正本はデータ用ブランチ `ai-board/data` に移り、npm の依存にも SQLite は無い。
それでも、移行用の `ai-board migrate` が Node に組み込みの `node:sqlite` で古い `.ai-board/board.db` を読むために、次のコードが残っている。

- `src/cards/cli/migrate-cli.ts` と、古い DB の読み出し `src/infrastructure/database.ts`（`LEGACY_SCHEMA_VERSION` を含む）
- `src/cli.ts` の `suppressSqliteWarning()`（`node:sqlite` の ExperimentalWarning を黙らせるためだけにあり、そのために本体を動的 import している）
- `src/shared/config.ts` の `DB_FILE` / `legacyDbPath()` と、CLI・サーバの `legacyDb`（データ用ブランチが無いとき、`board.db` があれば `migrate` を案内する分岐）
- `src/cards/repositories/card-files.ts` の `legacyCardFiles()`（本文に `## レビュー` を持つ移行前のカードをファイルにする。使うのは `migrate` だけ）
- テストの道具 `src/infrastructure/__tests__/legacy-database-fixture.ts` と、`migrate` / `database.ts` / `legacyCardFiles` のテスト

`4d7fe32`（issue-store）で SQLite を `migrate` の読み出しだけに縮め、そのときは移行のために残すと決めていた。
移行は済んだので、残す理由が無くなった。残っていると、実験的な API に頼るコードと、今の作りと食い違う説明（`card.ts` の docstring、詳細パネルの `.ai-board/board.db · <id>` の表示）が残り続ける。

ただし `migrate --empty`（`board.db` を読まずに空のデータ用ブランチを作る）は、移行とは別の役目で今も使っている。

- 新しいリポジトリで ai-board を使い始めるとき（データ用ブランチが無いときの CLI とサーバの案内がこれを指す）
- サブエージェントが `AI_BOARD_DATA` で試しの clone を用意するとき（`.claude/skills/board-loop/subagent-rules.md` の「動かして確かめるとき」）

この役目は残し、移行と切り離した名前のコマンドに移す。

### What Changes

- `ai-board init [--root <path>]` を足す。今の `migrate --empty` と同じく、空のデータ用ブランチを作って push する
  （形の版のファイル・空の `order.yaml`・`.ai-board/config.yaml` があればその写し）。データ用ブランチが既にあれば何もせずに止まる
- `ai-board migrate` を消す。`node dist/cli.js migrate` は、ほかの不明なサブコマンドと同じ扱いになる
- データ用ブランチが無いときの案内は 1 通りになる。「`ai-board init` を走らせてください」だけを出し、`board.db` の有無は見ない
- `node:sqlite` を読み込むコードが無くなり、`src/cli.ts` は本体を静的に読み込むだけになる
- 詳細パネルの本文エディタの下の表示 `.ai-board/board.db · <id>` を、今の置き場所 `ai-board/data · <id>` に直す
- README の「board.db からの切り替え」を、「移行は SQLite を消す前の版（`d2380ce`）の `ai-board migrate` で行う」案内に縮める。
  `docs/architecture.md` の SQLite の段落と `LEGACY_SCHEMA_VERSION` の 1 文も同じく縮める
- 許可ルール（`.claude/settings.json`）の `ask` の `migrate` を `init` に置き換える

### Impact

- 消すファイル: `src/cards/cli/migrate-cli.ts`、`src/infrastructure/database.ts`、`src/infrastructure/__tests__/legacy-database-fixture.ts`、
  `src/cards/cli/__tests__/migrate-cli.test.ts`、`src/infrastructure/__tests__/database.test.ts`
- 足すファイル: `src/cards/cli/init-cli.ts`、`src/cards/cli/__tests__/init-cli.test.ts`
- 変えるコード: `src/cli.ts`、`src/cli-main.ts`、`src/server.ts`、`src/shared/config.ts`、`src/cards/cli/data-store-messages.ts`、
  `src/cards/cli/card-cli.ts`、`src/board/cli/loop-cli.ts`、`src/cards/controllers/card-error-mappings.ts`、
  `src/cards/repositories/card-files.ts`、`src/cards/models/card.ts`、`src/infrastructure/data-store.ts`（コメントだけ）、
  `src/web/components/detail/BodyEditor.tsx`
- 変えるテスト: `src/shared/__tests__/config.test.ts`、`src/cards/cli/__tests__/card-cli.test.ts`、`src/board/cli/__tests__/loop-cli.test.ts`、
  `src/cards/repositories/__tests__/card-files.test.ts`、`src/__tests__/claude-settings.test.ts`
- 設定とドキュメント: `.claude/settings.json`、`.claude/skills/board-loop/subagent-rules.md`、`README.md`、`docs/architecture.md`、
  `docs/adr/0010-cards-on-data-branch.md`、`.gitignore`（コメントだけ）
- データ用ブランチの形（`ai-board-data.yaml` の版）は変えない。`init` が作るものは今の `migrate --empty` と同じである
- API と画面の振る舞いは変わらない（500 のときの文言と、エディタの下の表示だけが変わる）

## 設計

### Decisions

#### `migrate --empty` の役目は `ai-board init` に移す

`migrate` を丸ごと消すと、新しいリポジトリでデータ用ブランチを作る手段と、サブエージェントが試しの clone を用意する手段が無くなる。
`migrate --empty` だけを残す案もあるが、移行の済んだ後に「移す」という名前で空のブランチを作るのは読み手を迷わせる。
そこで、`createDataBranch`（`src/infrastructure/data-store.ts`）を呼ぶ薄いコマンド `init` を新しく足す。

`init` が書くものは今の `migrate --empty` と同じにする。

- `ai-board-data.yaml`（`serializeDataVersion()`）
- 空の `order.yaml`（`serializeOrder({ divider: null, ranks: {} })`）
- `.ai-board/config.yaml` があれば、データ用ブランチの根の `config.yaml` に写す
- コミットの題は `data: 空のデータ用ブランチを作る`

`--from` / `--empty` は持たない。受け付けるのは `--root` と `-h` / `--help` だけで、ほかの引数は使い方を出して終了コード 1 にする。
`AI_BOARD_DATA` を指したときに、そのディレクトリ（`origin` を持つ空の clone）に作るのも今と同じである（`repoRoot` を渡さない）。
失敗の文（`DataBranchExists` / `DataDirNotEmpty` / `DataDirNotRepository` / `DataStoreFetchFailed` など）は、`migrate-cli.ts` の `describeBranchError` を `init-cli.ts` に移して使う。

#### データ用ブランチが無いときの案内は `board.db` を見ない

今は `board.db` があれば `migrate` を、無ければ `migrate --empty` を案内している（`describeDataStoreError` の `legacyDb`）。
今の版では `board.db` を読めないので、有無で案内を分けても次の一手は変わらない。
案内は「`ai-board init` を走らせてください。移行前の `board.db` があるなら、README の『board.db からの切り替え』を見てください」の 1 通りにし、
`legacyDb` の引数・依存の項目・`legacyDbPath()`・`DB_FILE` をまとめて消す。

#### 移行していない人は、消す前の版で移行する

`migrate` を消すと、古い `board.db` しか持たない人は今の版では移行できない。
このリポジトリにはタグが無いので、README に消す直前の main のコミット `d2380ce` を書き、そこで `npm ci && npm run build && node dist/cli.js migrate` を走らせてから今の版に戻す手順を残す。
データ用ブランチの形の版は変えないので、`d2380ce` で作ったデータ用ブランチを今の版がそのまま読める。

#### `src/cli.ts` は静的 import にする

動的 import の段は、`node:sqlite` の警告を黙らせる差し替えを静的 import より前に置くためだけにあった。
差し替えを消すと段は要らないので、`src/cli.ts` は shebang と `import './cli-main.js';` だけにする。
`cli-main.ts` を `cli.ts` に畳む案は、差分が大きくなるわりに得るものが無いので採らない（`pid-file.ts` のコメントも `cli-main` を指している）。

#### 残すもの

- `.gitignore` の `/.ai-board/board.db*`。古いチェックアウトに残った DB とバックアップを誤ってコミットしないためで、コメントだけ「移行前のカードの正本」に直す
- `.claude/settings.json` の deny の `sqlite3` と、それを見る `claude-settings.test.ts` の確かめ。古い DB が残っている手元で、エージェントが直接いじるのを止める守りとして安く残せる
- `package.json` の `engines`（Node 24 以上）。`node-lts` の計画で 24 に広げた理由は CI と engines を揃えることで、SQLite には頼っていない
- ADR 0002 と ADR 0010 の背景の「かつて SQLite だった」という履歴の記述

### Risks

- **`init` の名前が `migrate --empty` を覚えている人やメモと食い違う。** 案内の文・README・`subagent-rules.md` をそろえて直し、`migrate` を打つと不明なサブコマンドとして使い方が出るので、気づける
- **`d2380ce` で移行する手順を誰も試していない。** 移行の残っている手元がもう無い見込みで、`migrate` のテストは消すコミットまで CI で通っている。README には「SQLite を消す前の版」とコミットを書くだけにとどめる

### Trade-offs

- `init` は `migrate --empty` とほぼ同じ処理を新しいファイルに書き直すことになる。`migrate-cli.ts` から関数を切り出して残す案より、移行のための組み立て（`buildDataFiles` / `compareMigratedCards` など）を丸ごと消せる方を採る

### Non-Goals

- データ用ブランチの形（`ai-board-data.yaml` の版、`order.yaml` の形）を変えること
- `ai-board init` に、既存のデータ用ブランチを作り直す・上書きする機能を持たせること
- Node の対応版を変えること
- `sqlite3` の deny ルールと `.gitignore` の `board.db*` を消すこと

## 動作確認の手順

共有のカードを汚さないよう、スクラッチパッドに bare リポジトリと clone を作って `AI_BOARD_DATA` で指す。

1. カードのワークツリーで `npm run build` を走らせる
2. `S=<スクラッチパッドの下の作業用ディレクトリ>` として、`git init --bare "$S/origin.git" && git clone "$S/origin.git" "$S/data"`
3. `AI_BOARD_DATA="$S/data" node dist/cli.js card list` → データ用ブランチが無く、`ai-board init` を走らせるよう案内されて終了コード 1 になる（`migrate` の文字も `board.db` のパスも出ない）
4. `AI_BOARD_DATA="$S/data" node dist/cli.js init` → 「空のデータ用ブランチを作りました」と「origin の ai-board/data へ push しました」が出る。
   `git -C "$S/origin.git" log --oneline ai-board/data` に `data: 空のデータ用ブランチを作る` の 1 コミットがある
5. もう一度 `AI_BOARD_DATA="$S/data" node dist/cli.js init` → 「既にあります」で何もせずに止まり、終了コード 1
6. `AI_BOARD_DATA="$S/data" node dist/cli.js card list` → `[]` が出る。`AI_BOARD_DATA="$S/data" node dist/cli.js status` が警告（ExperimentalWarning）を出さずに動く
7. `node dist/cli.js migrate` → 使い方と不明な引数のエラーが出る（ほかの不明なサブコマンドと同じ）
8. `grep -rn "node:sqlite\|legacyDb\|board\.db" src` → `.gitignore` 以外に当たりが無い（`claude-settings.test.ts` の `sqlite3 .ai-board/board.db` の 1 行だけは残る）
9. `AI_BOARD_DATA="$S/data" node dist/cli.js --no-open` でサーバを起動し、カードを 1 枚作って詳細パネルを開く。本文エディタの下に `ai-board/data · <id>` と出る。確かめたらサーバを止める

## タスク

### 1. `ai-board init` を足し、案内を `init` に向ける

- [x] `src/cards/cli/init-cli.ts` に `runInitCli(argv, deps, io)` を書く。`createDataBranch` に形の版・空の `order.yaml`・`config.yaml` の写しを書かせ、失敗の文は `migrate-cli.ts` の `describeBranchError` と同じものを持つ
- [x] `src/cards/cli/__tests__/init-cli.test.ts` を書く。既定の置き場所と `AI_BOARD_DATA` のそれぞれで作れて push されること、`config.yaml` を写すこと、既にあれば止まること、`--help` と不明な引数（`--empty` / `--from` を含む）
      （`migrate-cli.test.ts` の `--empty` と `AI_BOARD_DATA` の節を土台にする）
- [x] `src/cli-main.ts` に `init` のサブコマンドと使い方の行を足す
- [x] `src/cards/cli/data-store-messages.ts` の `DataBranchMissing` の案内を `ai-board init` の 1 通りにする（この節では `legacyDb` の引数は残し、使わない）。
      `src/cards/controllers/card-error-mappings.ts` の文も `ai-board init` に直す。`card-cli.test.ts` の案内の確かめを直す
- [x] `.claude/settings.json` の `ask` の `migrate` の 4 行を `init` に置き換え、`claude-settings.test.ts` の `migrate` の例も `init` に直す

### 2. `migrate` と SQLite の読み出しを消す

- [x] `src/cards/cli/migrate-cli.ts` と `src/cards/cli/__tests__/migrate-cli.test.ts` を消し、`src/cli-main.ts` から `migrate` のサブコマンド・使い方の行・`readLegacyBoard` の import を消す
- [x] `src/infrastructure/database.ts`、`src/infrastructure/__tests__/database.test.ts`、`src/infrastructure/__tests__/legacy-database-fixture.ts` を消す
- [x] `src/cards/repositories/card-files.ts` の `legacyCardFiles` と、`card-files.test.ts` のその節を消す（ほかで使わなくなる import も消す）
- [x] `src/cli.ts` の `suppressSqliteWarning()` と動的 import を消し、`import './cli-main.js';` だけにする
- [x] `src/infrastructure/data-store.ts` のコメントの `migrate` を `init` に直す

### 3. `legacyDb` を消す

- [x] `describeDataStoreError` から `legacyDb` の引数を消し、`card-cli.ts` / `loop-cli.ts` の依存の `legacyDb`、`cli-main.ts` の `legacyDbOf`、`server.ts` の `legacyDbPath` の呼び出しを消す
- [x] `src/shared/config.ts` の `DB_FILE` / `legacyDbPath()` とその説明の文を消し、`config.test.ts` の `legacyDbPath` の確かめを消す
- [x] `card-cli.test.ts` / `loop-cli.test.ts` の `legacyDb` を消し、`server-info.test.ts` の `dbPath: .../board.db` が要るかを見て、要らなければ消す

### 4. 説明とドキュメントを今の形にする

- [x] `src/cards/models/card.ts` の docstring を、データ用ブランチの `cards/<id>/card.md` と `log/` から組み立てる今の形に直す
- [x] `src/web/components/detail/BodyEditor.tsx` の `.ai-board/board.db · <id>` を `ai-board/data · <id>` に直す
- [x] README の「board.db からの切り替え」を、`d2380ce` の `ai-board migrate` で移行する案内に縮め、新しいリポジトリでは `ai-board init` を走らせることを書く。
      許可ルールの節の `ai-board migrate` を `ai-board init` に、`config.yaml` の節の `migrate` の 1 文を `init` に直す
- [x] `docs/architecture.md` の `migrate` と SQLite の段落・`LEGACY_SCHEMA_VERSION` の 1 文・データ用ブランチが無いときの案内・`config.yaml` の注を今の形に直す
- [x] `.claude/skills/board-loop/subagent-rules.md` の「動かして確かめるとき」の `migrate --empty` を `init` にし、`--from <board.db の複製>` の注を消す
- [x] `docs/adr/0010-cards-on-data-branch.md` の結果に、移行の `migrate` は `d2380ce` までの版にあり、空のデータ用ブランチは `ai-board init` で作ると 1 行足し、根拠にこの計画を足す
- [x] `.gitignore` のコメントを「移行前のカードの正本（SQLite）」に直す

## AI レビュー

- [x] `src/cards/controllers/card-error-mappings.ts:137` の `DataBranchMissing`（`DATA_BRANCH_MISSING`）の文は「ai-board init を走らせてください」で終わり、CLI の `describeDataStoreError`（`src/cards/cli/data-store-messages.ts:17`）にある「移行前の board.db があるなら、README の『board.db からの切り替え』を見てください」が無い。Decisions「データ用ブランチが無いときの案内は `board.db` を見ない」は案内を 1 通りにすると決めており、画面だけを見た `board.db` の持ち主が `init` を先に走らせると、`d2380ce` の `migrate` が `DataBranchExists` で止まる。HTTP の文にも同じ README への案内を足し、`card-error-mappings` のテスト（無ければ `src/cards/controllers/__tests__/` に足す）で `DataBranchMissing` の文が `ai-board init` と「board.db からの切り替え」を含むことを確かめる

### 見送った指摘

- `src/__tests__/claude-settings.test.ts:169` の allow の確かめが `rule.includes('migrate')` から `rule.includes('cli.js init')` に狭まり、`Bash(ai-board init *)` のような書き方を allow に足しても通る。`init` は `git init` などとも当たるので部分一致を狭めたもので、今の allow に該当するルールは無い。テストの守りの広さの話なので見送る
- `.claude/settings.json:20` の `ask` は `node [*/]dist/cli.js init` の形だけで、`ai-board init`（`package.json` の `bin`）や `node "$WT/dist/cli.js" init` の引用符付きの形は当たらない。`migrate` のときから同じ範囲で、この PR で狭まったものではないので見送る
- `src/cards/cli/init-cli.ts:62` は `config.yaml` を `createDataBranch` の有無の確かめより前に読むので、`config.yaml` が読めない（EACCES / ディレクトリ）と、ブランチが既にあるときも「既にあります」ではなく Node の例外で止まる。旧 `migrate` は確かめの後に読んでいた。起こりにくい境界で、`main().catch` で止まりはするので見送る
- `src/cards/cli/init-cli.ts:31` の `CONFIG_FILE` は `src/shared/config.ts` の `CONFIG_FILE` と同じ値の定義の重複、`init-cli.ts:129` の `readFileOrNull` も `data-store.ts` などにある同じ関数の写し。振る舞いを変えない整理なので見送る
- `src/infrastructure/data-store.ts:583` の `checkDataBranchAbsent` は、`migrate` が消えて `createDataBranch` の中からしか呼ばれないが、export のまま残っている。振る舞いを変えない整理なので見送る

### 人に判断してほしいこと

- `src/cards/cli/data-store-messages.ts:17` の案内は、誰にもまず「ai-board init を走らせてください」と言い、`board.db` の話はその後に続く。`board.db` の持ち主が先に `init` を走らせると空のデータ用ブランチが `origin` に push され、README の手順（`d2380ce` の `migrate`）は `checkDataBranchAbsent` で `DataBranchExists` になり、`origin` の `ai-board/data` を手で消すまで移行できない。Decisions はこの文を決めているので、「`board.db` があるなら `init` を走らせず README を見てください」のように順を入れ替えるか、今の文のままにするかは人が決める
