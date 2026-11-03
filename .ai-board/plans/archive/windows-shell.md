# Windows の Git Bash でも、手順書を書き換えずにボードとループを回せるようにする

## 提案

### Why

研修の受講者には Windows の人がいる。
今の手順書（`.claude/skills/` と `.claude/agents/`）とツールは macOS と Linux の端末を前提にしていて、Windows で動かすと環境の違いで止まる。
受講者がそこで止まると、ハーネスの中身ではなく環境の問題で研修の時間が消える。

カードの探索メモの調査（クラウドの Linux から読んだだけで、Git Bash の実機では確かめていない）で、止まりそうな所は次のとおりと分かった。

- **`jq` が無い。** Git Bash に入っていないコマンドで手順書が使っているのは `jq` だけで、`board-decide` のスキルに 9 行ある。
  `sed`・`grep`・`diff`・`date`・`curl`・プロセス置換は Git for Windows に同梱されるので、そのまま動く見込み
- **改行コード。** `.gitattributes` が無い。Git for Windows の既定（`core.autocrlf=true`）で clone すると作業ツリーが CRLF になり、
  `npm run format:check` が全ファイルで落ちる見込み（prettier の `endOfLine` の既定は `lf`）。
  データのワークツリー（`.ai-board/data/`）も同じ設定で取り出されるので、カードのファイルも CRLF になる。
  `## レビュー` の読み取り（`src/cards/services/review-log.ts`）は `\n` で分割していて、CRLF のまま読んだときの挙動は確かめていない
- **ブラウザを開く処理。** `src/cli-main.ts` の `openBrowser` は Windows で `start` を `spawn` するが、`start` は cmd の組み込みなので ENOENT になる見込み。
  失敗は子プロセスの `error` イベントで出るので `try/catch` では捕まらず、リスナーが無いのでサーバごと落ちうる
- **`board-decide` のサーバの pid。** スキルはサーバを `&` で起動して `$!` を pid として控え、起動を待つ間は `node` の `process.kill(pid, 0)` で生きているかを見る。
  Git Bash の `$!` は MSYS の pid で、Windows の pid とは別の番号なので、`node` からは「起動中に終わった」と見える見込み

### What Changes

使う人から見た変化は次のとおり。

- Windows の Git Bash で、`jq` を入れずに `board-decide` のスキルと `/board-loop` が回る
- Windows で clone しても、改行コードの違いで品質ゲート（`format:check`）が落ちない。カードのファイルも LF のまま取り出される
- Windows で `ai-board` を起動すると、既定のブラウザが開く。開けなくてもサーバは落ちない
- `ai-board status --json` に `--only <項目,...>` が増え、要る項目だけを出せる（`jq` の絞り込みの代わり）
- サーバに `--pid-file <path>` が増え、自分の pid（OS の pid）をファイルに書く（`board-decide` が起動を待つ・止めるのに使う）
- CI に Windows の行が増え、型検査・lint・整形の検査・ビルドが Windows でも通ることを確かめる（テストは走らせない。Non-Goals を見る）
- README に「Windows で使う」節が増える

### Impact

- 改行コード: `.gitattributes`（新規）、`src/infrastructure/data-store.ts`（データのワークツリーを触る git に `-c core.autocrlf=false`）
- ブラウザ: `src/cli-main.ts`、`src/infrastructure/open-browser.ts`（新規）
- CLI: `src/board/cli/status-cli.ts`（`--only`）、`src/cli-main.ts`（`--pid-file`）
- 手順書: `.claude/skills/board-decide/SKILL.md`、`.claude/skills/board-loop/SKILL.md`
- CI: `.github/workflows/ci.yml`
- ドキュメント: `README.md`、`CLAUDE.md`（`status` の使い方の行）、`docs/architecture.md`（CLI の節に `--only` と `--pid-file`）
- データ用ブランチの形（`ai-board-data.yaml` の版）は変えない。API も変えない

## 設計

### Decisions

#### Windows で動かす範囲（案 A）

範囲は「手順書と、サーバ・CLI の実際の動作」までにする（探索メモの案 A）。
テストを Windows の CI で通すこと（案 B）は別のカードに分ける。

テストは 48 ファイルあり、うち 5 つが `/tmp` などの POSIX 形式のパスを直接書き、9 つが `git` を実際に走らせ、1 つが `chmod` を使う。
これらを Windows で通すにはテストの書き方を広く直すことになり、受講者が止まる問題（手順書と実際の動作）とは別の話である。
CI の Windows の行は、テスト以外（`typecheck` / `lint` / `format:check` / `build`）と、ビルドした CLI の起動だけを確かめる。

#### `jq` を何に置き換えるか

`jq` の使い方は 2 種類あり、置き換え先を分ける。

| 使い方                                  | 置き換え先                                        |
| --------------------------------------- | ------------------------------------------------- |
| `status --json` から要る項目を絞り込む  | `ai-board status --json --only <項目,...>`        |
| 人の API に送る JSON の本文を組み立てる | `node -e` の 1 行（値は `process.argv` から渡す） |

絞り込みを `status` 側に足すのは、`board-loop` の手順書も今 `node -e` で同じ絞り込みをしていて、2 つの手順書が同じ形の絞り込みを持つからである。
`--only` に寄せれば、手順書から JSON を扱うコードが減る。

JSON の組み立てを `ai-board` の CLI に足さない（例えば `ai-board decide approve <id>` を作らない）のは、CLAUDE.md の書き込み境界のためである。
`ai-board` の CLI はエージェントも使う入口で、承認 / 否決 / 中止を書く入口が無いことで、エージェントが人の判断を書けないことを構造で守っている。
`node -e` で本文を組み立てて `curl` で人の API に送るのは今と同じ経路で、入口は増えない。

`node -e` の値は文字列連結で埋め込まず、`process.argv` から受ける（`node -e '<code>' "<gate>" "<kind>" "<reason>"`）。
理由やタイトルに引用符や改行が入っても壊れないようにするためで、今の `jq -n --arg` と同じ考え方である。
`date -u` で作っていた着手の時刻も、`node -e` の中で `new Date().toISOString()` から作る。

#### `--only` の形

`--only` はコンマ区切りの項目の並びを受ける。項目は次の 2 つの形のどちらかである。

- `<key>`: 出力の最上位の項目をそのまま出す（例: `next`、`waiting`、`server`）
- `<key>.<field>`: 最上位の配列の項目について、各要素から `<field>` だけを出す（例: `cards.id`、`cards.stage`）

例: `status --json --only server,waiting,ideas,cards.id,cards.title,cards.stage` は
`{"server": ..., "waiting": [...], "ideas": [...], "cards": [{"id": ..., "title": ..., "stage": ...}, ...]}` を出す。

- `--only` は `--json` と一緒のときだけ使える。`--html` や形の指定なしと一緒なら、使い方を出して失敗する
- 無い最上位の項目や、配列でない項目に `.` を付けたものは、使い方の誤りとして失敗する（打ち間違いを黙って空にしない）。
  要素に無い `<field>` は、その要素では出さない（カードによって無い項目があるため）
- `.` の入れ子は 1 段だけにする。`cards.mrState.webUrl` のような深い指定は受けない。手順書が要る深さは 1 段までで、汎用の問い合わせ言語は作らない
- 絞り込みは出力を組み立てた後の純関数（`pickFields`）にし、PR の番号の書き戻しなど `status` の振る舞いは変えない

`board-decide` が今 `jq` で出している `pr: .mrState.webUrl` は、`cards.mrState` で `mrState` ごと出す形に変える（項目は数個で、文脈は大きく膨らまない）。

#### 改行コードをどう揃えるか

2 か所で揃える。

1. **リポジトリ:** `.gitattributes` に `* text=auto eol=lf` を書く。テキストのファイルは、`core.autocrlf` の設定によらず LF で取り出される。
   画像などのバイナリは git の自動判定に任せる
2. **データのワークツリー:** データ用ブランチ `ai-board/data` は別のブランチなので、メインの `.gitattributes` は効かない。
   データ用ブランチに `.gitattributes` を足すと形が変わり、古い CLI との食い違いの元になる。
   そこで、`data-store.ts` がデータのワークツリーを作る・取り直す・書く git の呼び出しに `-c core.autocrlf=false` を付ける。
   CLI とサーバは LF で書くので、付ければ取り出しも LF になり、CRLF の本文を読む場面が無くなる

読み取りの側（`review-log.ts` など）を CRLF に耐えるよう直す案もあるが、読む箇所が多く、取りこぼしが出やすい。
入口（取り出し）で揃えれば、読み取りの側は今の LF 前提のままでよい。

#### ブラウザの開き方

Windows では `rundll32 url.dll,FileProtocolHandler <url>` を引数の配列で `spawn` する。
`cmd /c start "" <url>` は cmd の引数の解釈を通るので、URL に `&` などが入ると壊れる。ai-board の URL には入らないが、shell を介さない方に揃える（CLAUDE.md の外部コマンドの不変条件と同じ考え）。

- どのコマンドを使うかは `browserCommand(platform, url)` の純関数にし、`src/infrastructure/open-browser.ts` に置いてテストする
  （`cli-main.ts` は読み込むと `main()` が走るのでテストから読めない）
- 子プロセスに `error` のリスナーを付ける。開けなくても URL は起動ログに出ているので、警告を 1 行出して続ける

#### `board-decide` のサーバの pid をどう取るか

サーバに `--pid-file <path>` を足し、起動したら `process.pid` をそのファイルに書く。
`board-decide` は `$!` の代わりにこのファイルを読み、起動を待つ間の生存確認と、止めるのに使う。

- 止めるのは `kill -TERM` から `node -e 'process.kill(<pid>, "SIGTERM")'` に変える。Git Bash の `kill` は MSYS の pid を受けるので、OS の pid を渡すと別のプロセスを指しうる
- Windows の `process.kill(pid, 'SIGTERM')` は強制終了になり、サーバは `server.json` を消さずに終わる。
  `status` は `server.json` の pid が生きているかを確かめてから `server` を出すので（`findLiveServer`）、残ったファイルは無視される
- pid のファイルはサーバが書くだけで、消さない（`$RUN` はスキルが起動の前に消してから使う）
- `/proc/<pid>/winpid` を読む案もあるが、手順書に OS ごとの分岐が入るので採らない

### Risks / Trade-offs

- **実機で確かめていない。** 探索も計画もクラウドの Linux から読んだだけで、Git Bash の実機の挙動（`$!` の番号、`start` の ENOENT、`rundll32` で開けるか）は見込みである。
  動作確認のゲートで、人（か研修の講師）が Windows で手順を通す
- **CI の Windows の行が遅い・不安定になる。** Windows のランナーは `npm ci` が遅い。テストを走らせないので、行の時間は Linux と大きく変わらない見込み。
  落ち続けるようなら、行を `continue-on-error` にするかを人が決める
- **Windows でテストが落ちることを CI が教えない。** 受講者が手元で `npm test` を走らせると落ちうる。README の「Windows で使う」節に、テストは Windows を対象にしていないと書く
- **既存の Windows の clone。** `.gitattributes` を足しても、既に CRLF で取り出した作業ツリーはそのまま残る。README に、取り出し直す手順（`git rm --cached -r . && git reset --hard`）を書く
- **このカード自身は今の手順書で進む。** 手順書はメインのチェックアウトから読まれるので、マージまでは今の `board-decide` と `board-loop` のままである

### Non-Goals

- テストを Windows で通すこと（案 B）。別のカードにする
- `sed`・`grep`・`diff`・`curl` など、Git Bash に同梱されるコマンドの置き換え（カードのアイデアにある「`sed` を置き換える」は外す）
- PowerShell や cmd で手順書を回すこと。想定するシェルは Windows の Claude Code が使う Git Bash だけにする
- データ用ブランチの形を変えること（`.gitattributes` をデータ用ブランチに足さない）
- 人の判断を書く入口を `ai-board` の CLI に足すこと

## 動作確認の手順

共有のカードを汚さないよう、どの手順も `AI_BOARD_DATA` でスクラッチの clone を指す（`.claude/skills/board-loop/subagent-rules.md` の「動かして確かめるとき」）。

### Linux / macOS で（AI も人も確かめられる）

1. `npm run build` の後、`node dist/cli.js status --json --only next,waiting,forge --root .` が 3 つの項目だけを出す
2. `node dist/cli.js status --json --only server,cards.id,cards.stage --root .` の `cards` の各要素が `id` と `stage` だけを持つ
3. `--only nosuch`、`--only cards.id --html`、`--only next.id`（`next` が配列でないとき）が、使い方を出して終了コード 1 で終わる
4. `git config core.autocrlf true` にした clone を `AI_BOARD_DATA` で指して `ai-board card create` で 1 枚作り、データのワークツリーの `card.md` に `\r` が無い（`grep -c $'\r'` が 0）

### Windows の Git Bash で（人が確かめる）

1. 既定の設定（`core.autocrlf=true`）のまま新しく clone し、`npm ci && npm run typecheck && npm run lint && npm run format:check && npm run build` が通る
2. `node dist/cli.js` を起動すると既定のブラウザでボードが開く。サーバは落ちない
3. Claude Code（Windows）で `board-decide` のスキルを使い、スクラッチのカードを 1 枚承認する。`jq` を入れていないまま、サーバの起動・書き込み・停止まで通る。
   止めた後に `status` の `server` が `null` になる
4. `/board-loop` を 1 周回す。ボードを読む手順（`status --json --only next,waiting,forge`）で止まらない

## タスク

### 1. 改行コード

- [x] `.gitattributes` に `* text=auto eol=lf` を書く。`git add --renormalize .` で差分が出ないことを確かめる
- [x] `data-store.ts` で、データのワークツリーを作る・取り直す・書く git の呼び出し（`worktree add`、`clone`、`reset --hard`、`checkout` など）に `-c core.autocrlf=false` を付ける
  - テスト: `core.autocrlf=true` のリポジトリでデータのワークツリーを作り、カードを書いて取り直した後も `card.md` が LF のまま

### 2. ブラウザを開く処理

- [x] `src/infrastructure/open-browser.ts` に `browserCommand(platform, url)` と `openBrowser(url)` を置く。Windows は `rundll32 url.dll,FileProtocolHandler <url>`、子プロセスに `error` のリスナーを付ける
- [x] `src/cli-main.ts` の `openBrowser` をこれに差し替える
  - テスト: `darwin` / `linux` / `win32` で、コマンドと引数の配列が期待どおり

### 3. `status --only`

- [x] `parseStatusArgs` に `--only <項目,...>` を足す（`--json` と一緒のときだけ）。`STATUS_USAGE` を直す
- [x] 出力を組み立てた後に絞る純関数 `pickFields` を足し、`--json` の出力に通す。無い項目・配列でない項目への `.`・2 段以上の `.` は使い方の誤り
  - テスト: 最上位の項目 / 配列の要素の項目 / 両方の混在 / 要素に無い項目は出さない / 誤りの 3 種 / `--only` と `--html` の組み合わせ

### 4. サーバの `--pid-file`

- [x] `src/cli-main.ts` の `parseArgs` に `--pid-file <path>` を足し、起動後に `process.pid` を書く。書けなければ警告を出して続ける。使い方の文言を直す
  - テスト: pid を書く処理を純関数か小さな関数に切り出し、`src/**/__tests__/` でファイルに pid が書かれることを確かめる

### 5. 手順書

- [x] `.claude/skills/board-decide/SKILL.md` の `jq` をすべて置き換える
  - ボードを読む: `status --json --only server,waiting,ideas,cards.id,...,cards.mrState`
  - URL を読む: `status --json --only server`
  - 人の API の本文: `node -e` の 1 行で、値は `process.argv` から受ける。着手の時刻は `node` の中で作る。`skipGates` の出し入れも `node -e` で行う
  - サーバの起動を `--pid-file "$RUN/pid"` に変え、`echo $! > "$RUN/pid"` を消す。止めるのを `node -e 'process.kill(...)'` に変える
  - 「`jq -n --arg` で組み立てる」の説明を、`process.argv` で渡す理由に書き直す
- [x] `.claude/skills/board-loop/SKILL.md` のボードを読む手順を `status --json --only next,waiting,forge` に変える
- [x] `.claude/` の下に `jq` が残っていないことを `grep -rn '\bjq\b' .claude/` で確かめる

### 6. CI

- [x] `.github/workflows/ci.yml` に `windows-latest` の行を足す（Node は 24 の 1 つ）。`npm ci` / `typecheck` / `lint` / `format:check` / `build` と、`node dist/cli.js status --help` を走らせる。テストは走らせない
  - Linux の行は今のまま（テストとカバレッジを含む）にする。`matrix` で分けるか job を分けるかは、条件の分岐が少ない方を選ぶ

### 7. ドキュメント

- [x] `README.md` に「Windows で使う」節を足す（想定するシェルは Git Bash、`jq` は要らない、テストは Windows を対象にしていない、既存の CRLF の clone の取り出し直し方）
- [x] `CLAUDE.md` の `ai-board status` の行と、`docs/architecture.md` の CLI の説明に `--only` と `--pid-file` を足す

### 8. 確かめる

- [x] 品質ゲートと `npm run build` を通し、`## 動作確認の手順` の「Linux / macOS で」を `AI_BOARD_DATA` のスクラッチの clone で試す

## AI レビュー

- [x] `src/infrastructure/data-store.ts:56` の `DATA_GIT_CONFIG` は `core.autocrlf=false` だけで、`core.eol` は既定の `native`（Windows では CRLF）のまま。人の `core.attributesFile` やシステムの gitattributes に `* text=auto` などがあると、データ用ブランチには `.gitattributes` が無いのでその属性が効き、カードが CRLF で取り出される（計画の Decisions「改行コードをどう揃えるか」の LF の保証が崩れる）。`DATA_GIT_CONFIG` に `-c core.eol=lf` を足し、`data-store.test.ts` に、リポジトリに `core.attributesFile`（`* text=auto` を書いたファイル）と `core.eol=crlf` を設定しても `card.md` が LF のまま取り出されるテストを足す
- [x] `src/cli-main.ts:379` で `--pid-file` を書くのが `fs.existsSync(root)` の確かめと `warnIfNothingToShow` の後なので、`--root` が無いなどで起動の前に終わると pid のファイルが書かれない。`board-decide` の起動を待つ手順（`SKILL.md` の手順 4 の 2）は `pid > 0` のときだけ生存を見るので、すぐ終わったサーバを 60 秒待ってから報告する（前の `echo $!` なら 500ms で気づけた）。`writePidFile` の呼び出しを `parseArgs` の直後（`help` の判定の後、`root` の確かめの前）へ移し、コメントの理由もそれに合わせる
- [x] `src/cli-main.ts:54` の最上位の `USAGE` が `ai-board status [--json | --html]` のままで、手順書が頼る `--only` が `ai-board --help` に出ない。`ai-board status [--json [--only <項目,...>] | --html]` の形に直す（`STATUS_USAGE`・README・CLAUDE.md と揃える）

- [x] 人の判断（2026-11-02、計画のタスク 4 の決め事を変える）: `--pid-file` を渡されて pid のファイルを書けなかったときは、警告して続けるのではなく、起動をやめて終了コード 1 で終わる。`cli-main.ts` の `writePidFile` の呼び出しと、そのテスト・USAGE・README の説明を合わせる
- [x] 人の判断（2026-11-02）: `src/infrastructure/open-browser.ts` の `spawn` を `src/infrastructure/cli-runner.ts` に移す。`cli-runner.ts` に切り離して起動する入口（detached / unref、shell 無し、引数は配列、`error` のリスナー付き）を足し、`open-browser.ts` はそれを使う。CLAUDE.md の「外部コマンドは cli-runner.ts に閉じる」の例外は作らない
### 見送った指摘

- `src/board/cli/status-cli.ts:185` の `--only cards.<field>` は、`<field>` を打ち間違えても（`cards.stgae`）失敗せず空のオブジェクトを並べる。計画の Decisions「`--only` の形」が「要素に無い `<field>` は、その要素では出さない」と決めており、手順書の項目は固定の文字列なので見送る
- `.claude/skills/board-decide/SKILL.md:34` で、前は `mrState.webUrl` だけだったのが `cards.mrState` を丸ごと出すようになり、出力が増える。計画の Decisions（入れ子は 1 段まで、`mrState` ごと出す）どおりなので見送る
- `src/board/cli/status-cli.ts:243` の `withImplStep` は、`--only` が `next` を含まないときも計画を git で読み、結果を捨てる。振る舞いは変わらない小さな無駄なので見送る
- `src/board/cli/status-cli.ts:184` で `--only` の値が誤っているとき、どの項目が誤りかを言わずに使い方だけを出す。`board-loop` の手順書は「使い方だけが出たら `$MAIN` が古い」と読むが、手順書の項目は固定なので誤りの値は出ない。見送る
- `src/infrastructure/data-store.ts:56` で、この変更の前に Windows で `core.autocrlf=true` のまま取り出したデータのワークツリーは CRLF のまま残り、stat が変わったファイルを `add --all` が変換なしでコミットしうる。Git Bash の実機で確かめられず、前に Windows でデータのワークツリーを作った人に限られるので見送る（README の「Windows で使う」節に、データのワークツリーの取り直しも書き足すかは動作確認で判断する）

### 人に判断してほしいこと

人が 2026-11-02 に回答し、2 件とも上の直す指摘に移した。

- `src/cli-main.ts:380` で `--pid-file` を書けなかったとき、警告だけでサーバは動き続ける。`board-decide` の「止める」手順は pid のファイルを読むので、書けなければ止められず、`run_in_background` の `wait` が終わらない。計画のタスク 4 は「書けなければ警告を出して続ける」と決めているので、そのままにするか、`--pid-file` を渡されたときは書けなければ起動をやめる（終了コード 1）に変えるかは人が決める
- `src/infrastructure/open-browser.ts:34` は `node:child_process` の `spawn` を `cli-runner.ts` の外で使う。CLAUDE.md の「外部コマンドは `cli-runner.ts` に閉じる」と食い違うが、前の `cli-main.ts` の `openBrowser` から移したもので、引数は配列で shell を介さず、計画の Decisions もこの場所に置くと決めている。`cli-runner.ts` に切り離して起動する入口を足すか、このままにするか（ADR か CLAUDE.md に例外として書くか）は人が決める
