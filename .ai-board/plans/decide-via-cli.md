# チャットで頼んだ人の判断を `ai-board decide` の CLI で書き、`board-decide` を判断の決まりだけにする

## この計画で使う言葉

- **人の判断:** 承認 / 否決 / 中止、着手 / 着手を戻す、飛ばす宣言の出し入れ、アイデアの並べ替え（区切り線を含む）。今は画面のボタンと人の API（`/api/...`）だけが書く
- **判断の CLI:** この計画で足す `ai-board decide`。人がチャットで頼んだ判断を、Claude がサーバを起動せずに書くための口
- **カードの CLI:** 今の `ai-board card`。AI が書いてよいもの（本文・ブランチ・提出 / 再提出 / 保留）だけを持つ

## 提案

### Why

人がチャットで判断を頼むと、`board-decide` のスキルはサーバをこのセッションの中で起動し、人の API を叩き、止める。
手順書（299 行）のかなりの部分がこのためのシェル（`mktemp`・`trap`・起動待ち・`server.json` からの URL の読み出し・`--pid-file`）と、
Windows / MSYS の注意書き（`MSYS_NO_PATHCONV`、`$!` と OS の pid、SIGTERM）で占められている。
判断を頼むたびにこれを読み込み、起動待ちで数秒〜数十秒かかる。

ADR 0007 が CLI に人の判断の入口を足さなかった理由は「ループが日常的に使う道具の境界を崩す」だった。
`loop-single-session` で、CLI を日常的に使うのは本筋のセッション（人と会話しているセッション）になり、
`board-decide` も同じ本筋のセッションが使うので、CLI の構造で分けても守れる相手はもう `board-reviewer` だけである。
その `board-reviewer` も人の API を Bash から叩けるので、今も守りの実体は手順書の決まりにある。

2026-11-04 に人が次を決めた（カードの探索メモ）。

- HIL の守りは**手順書の決まりだけ**にする。`ask` / `deny` で判断の CLI を止める案はとらない
- `slim-decide`（`board-decide` の手順書を判断の決まりだけに絞る）は、このカードにまとめる

### What Changes

- **`ai-board decide` を足す。** 人の判断を、サーバを起動せずに書く。中身は人の API と同じ usecase を、サーバと同じ組み立て（`createTransactionalCardDependencies`）で呼ぶ
  - `approve <id> [--reason <t>]` / `reject <id> --reason <t>` / `abort <id> [--reason <t>]` — plan ゲートへの 承認 / 否決 / 中止
  - `start <id>` / `unstart <id>` — 着手 / 着手を戻す
  - `skip <id> --gate plan` / `skip <id> --gate plan --remove` — 飛ばす宣言を入れる / 外す
  - `move <id> --after <ref> --before <ref>` / `move-divider --after <id> --before <id>` — アイデアの並べ替え（`<ref>` はカード ID・`:divider`・`none`）
- **判断の CLI は画面で押せないものを書かない。** 書く前に `status` と同じ組み立てでボードを導出し、
  承認 / 否決 / 中止は `decisionsFor` に、着手 / 着手を戻すは `droppableStages` と今の列に、並べ替えは `ideas` にあるかを確かめる。
  無ければ、今の列と出せる判断を出して終了コード 1 で終わる
- **書いた後に、カードの列の移りを 1 行で出す**（例: `decide-via-cli: plan 承認 を書きました（計画レビュー → 実装中）`）。`board-decide` はこの行を人に伝えるだけにする
- **`board-decide` の手順書を判断の決まりだけにする。** サーバの起動・停止・URL の読み出し・`node -e` で JSON を組む行・MSYS の注意書きを消し、`ai-board decide` の 1 行に置き換える。
  `slim-decide` の残り（理由の扱いの例外、判断待ちの一覧の聞き方の細則）も短くする
- **`--pid-file` を消す。** `board-decide` がサーバを止めるためだけに足したもので、使う者がいなくなる
- **境界の書き方を直す。** `CLAUDE.md`・README・`docs/architecture.md`・`card-review-authority` の仕様・ADR 0007 を、「人の判断は画面・人の API・判断の CLI から書く。Claude が判断の CLI を使うのは人がこの会話で頼んだときだけ」に書き直す

### Impact

- `src/board/cli/decide-cli.ts`（新規）と、そのテスト `src/board/cli/__tests__/decide-cli.test.ts`
- `src/cli-main.ts`（`decide` の振り分けと組み立て、`--pid-file` の削除）、`src/infrastructure/pid-file.ts` とそのテストの削除
- `.claude/skills/board-decide/SKILL.md`（書き直し）、`.claude/skills/board-loop/SKILL.md`・`rules.md`、`.claude/agents/board-reviewer.md`（使わない口に `ai-board decide` を足す）
- `CLAUDE.md`、`README.md`、`docs/architecture.md`、`docs/specs/card-review-authority/spec.md`、`docs/adr/0007-board-decide.md`
- カードの CLI（`src/cards/cli/card-cli.ts`）と人の API は変えない

## 設計

### Decisions

#### 判断の CLI は `ai-board card` に混ぜず、`ai-board decide` に分ける

`ai-board card` は「AI が書いてよいものだけ」という形をそのまま残す。docstring と使い方もそのまま正しい。
人の判断は別のコマンドにまとめ、使い方の頭に「人がこの会話で自分の言葉で頼んだときだけ使う。`board-reviewer` とループの周の中では使わない」と書く。
人が決めたとおり、`.claude/settings.json` の `ask` / `deny` には置かない。auto モードのループはこの CLI を呼んでも止められない。守りは手順書の決まりと、`## レビュー` に残る記録である。

#### 同じ usecase を、サーバと同じ組み立てで呼ぶ

書き込みは `createTransactionalCardDependencies(store)` の `appendReviewCommand` / `updateCardMetaCommand` / `moveCardCommand` / `moveIdeaDividerCommand` を呼ぶ。
コミットと push は人の API と同じ `transact` の中で起き、コミットのメッセージも同じになる。
引数の値は配列のまま usecase に渡し、文字列連結で JSON やコマンドを組まない（`node -e` で JSON を組む手順が要らなくなる）。

#### 画面で押せる判断だけを書く

人の API は種別の検査（承認 / 否決 / 中止だけ）しかせず、今どの判断を出せるかは画面のボタンの出し分け（`decisionsFor` / `droppableStages`）と `board-decide` の手順書が持っている。
判断の CLI は、手順書で確かめていたことをコードに移し、書く前に次を確かめる。

| サブコマンド                   | 書ける条件                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------- |
| `approve` / `reject` / `abort` | `decisionsFor(card)` に同じ `kind` がある（PR中・中止済み・判断を待っていないカードは拒む） |
| `reject`                       | `--reason` が空でない（`reasonRequired`）                                                   |
| `start`                        | 今が `idea` で、`droppableStages` に `planning` がある                                      |
| `unstart`                      | 今が `planning` で、`droppableStages` に `idea` がある                                      |
| `skip`                         | 中止されていない。`--gate` は `plan` だけ                                                   |
| `move` / `move-divider`        | 動かすカードと `--after` / `--before` のカードが `ideas` にある                             |

ボードの導出は `status` と同じ組み立て（データ用ブランチの取り直し、PR の状態を 1 回取る、`getBoardQuery`）を使う。
導出と書き込みの間に別の者がカードを書く窓は残るが、画面（ボードを読んでからボタンを押す）と同じ広さで、`## レビュー` は追記なので消えない。

GitHub に繋がらない（`forge` が `connected` でない）ときは、承認 / 否決 / 中止を拒む。
PR の状態が引けないと、計画レビューのカードが手前の列に落ちて見え、出せる判断を取り違えるためである（`status` が `next` を `null` にするのと同じ理由）。
着手・飛ばす宣言・並べ替えは PR の状態に依らないので、繋がらなくても書く。

#### 書く前の確かめは `board-decide` に残す

中止・着手を戻す・計画レビューのカードへの plan の宣言は、今どおり `board-decide` が送る中身を見せて AskUserQuestion で確かめてから CLI を呼ぶ。
CLI に `--yes` のような確かめの段は作らない。確かめは人との会話の中のことで、CLI の引数では人が頼んだかを区別できないためである。

#### `board-decide` に残すもの

人がこの会話で自分の言葉で頼んだときだけ書く、頼まれた判断だけを書く、曖昧な言葉を承認と決めつけない、
否決の理由は人の言葉（会話の中を指すときは起こした文面を人に選ばせる）、書く前に確かめる操作、書いた後にループを続けるか（ADR 0013）、判断待ちの一覧の出し方。
理由の例外の規則と一覧の聞き方は、例と細則を削って決まりだけにする（`slim-decide` の論点）。

#### `--pid-file` を消す

`--pid-file` は、Windows の Git Bash で `$!` が OS の pid にならないため、`board-decide` がサーバを止める pid を取るために足した。
サーバを起動しなくなるので使う者がいない。`server.json` の pid（`status` の `server` の生存の確かめ）はサーバ自身が書くもので、残す。
`status --json` の `server` の項目も、人が起動したサーバを知らせるものとして残す。

#### ADR と仕様

ADR 0007 を書き直す。決定の「CLI に人の判断の入口を足さない」を外し、「人の判断の CLI を `ai-board decide` に分け、守りは手順書の決まりに置く」にする。
退けた案に「`ask` に置いて呼ぶたびに人に確かめさせる」「`deny` に置いて人が自分の端末で打つ」を、人がとらなかった理由（チャットで頼んだ言葉そのものが確かめで、もう一度の許可は二度手間 / Claude が代わりに書けなくなる）と一緒に足す。
`card-review-authority` の仕様の「承認 / 否決 / 中止 は人だけが書ける」は、「人と、人がこの会話で頼んだ Claude（判断の CLI）」に書き直し、AI エージェントが自分の判断で書いてはならない（SHALL NOT）は残す。

### Risks / Trade-offs

- **構造の守りを手放す。** 「AI は構造上、承認を書けない」が、「AI は手順書の決まりで承認を書かない」になる。
  `board-reviewer` やループの周が手順書を破れば、承認を書けてしまう。破っても `## レビュー` に記録が残り、PR のマージは人がするので、最後の関門は残る。
  人が 2026-11-04 にこの形を選んだ
- **導出と書き込みの間の窓。** 上のとおり、画面と同じ広さで受け入れる
- **CLI の実行時間。** 承認などは書く前にボードを導出するので、PR の状態を 1 回取る分の時間がかかる。サーバの起動待ちより短い

### Non-Goals

- 人の API・画面のボタンの変更
- `ai-board card` の CLI の変更
- `.claude/settings.json` で判断の CLI を止める・確かめさせること（人がとらなかった）
- `decide-guard` / `decide-guard-settings` で考えた、hook でサブエージェントを止める仕組み
- PR中 のカードの判断（今どおり GitHub で PR をマージして判断する）

## 動作確認の手順

共有のカードを汚さないよう、`.claude/skills/board-loop/rules.md` の「動かして確かめるとき」に従い、スクラッチパッドの bare リポジトリを `origin` にした clone を `AI_BOARD_DATA` で指す。

1. `npm run build` のあと、`AI_BOARD_DATA="$S/data" node dist/cli.js init` で空のデータ用ブランチを作り、`card create` でアイデアカードを 2 枚作る
2. `decide move <2 枚目> --after none --before <1 枚目>` で並びが入れ替わる（`status --json --only ideas`）
3. `decide start <1 枚目>` で計画提案中に移り、出力に「アイデア → 計画提案中」が出る。続けて `decide unstart` でアイデアに戻る
4. `decide approve <アイデアのカード>` が、出せる判断が無いことを出して終了コード 1 で終わり、カードの本文が変わらない
5. `decide skip <カード> --gate plan` / `--remove` で `skipGates` が出入りする
6. `decide reject <カード>` を `--reason` 無しで呼ぶと拒まれる
7. 計画レビューのカードへの 承認 / 否決 は、PR の状態が要るので単体のテストで確かめる（e2e では GitHub に繋がらない）
8. `git -C "$S/data" log --oneline` に、書いた判断ごとにコミットがあり、`$S/origin.git` へ push されている
9. `node dist/cli.js --help` の使い方に `--pid-file` が無く、`decide` の行がある

## タスク

### 1. `ai-board decide` の CLI

- [x] `src/board/cli/decide-cli.ts` に、引数の解析・使い方・サブコマンド（`approve` / `reject` / `abort` / `start` / `unstart` / `skip` / `move` / `move-divider`）を書く。依存（ボードの導出、カードの書き込みの usecase、`forge` の状態）は引数で受ける
- [x] 書く前の確かめ（設計の表）と、書いた後の列の移りの 1 行を書く
- [x] `src/cli-main.ts` に `decide` の振り分けを足し、`status` と同じ組み立てでボードを、`createTransactionalCardDependencies` で書き込みを渡す。`USAGE` に `decide` の行を足す
- [x] `src/board/cli/__tests__/decide-cli.test.ts` に、各サブコマンドの書ける / 拒む場合、`reject` の理由の必須、`forge` が繋がらないときの承認の拒否、書いた後の 1 行のテストを書く

### 2. `--pid-file` を消す

- [x] `src/cli-main.ts` の `--pid-file` の解析・`USAGE`・書き込みと、`src/infrastructure/pid-file.ts` とそのテストを消す

### 3. 手順書を `ai-board decide` に移す

- [x] `.claude/skills/board-decide/SKILL.md` を書き直す。サーバの起動と停止・人の API の行・MSYS の注意書きを消し、`ai-board decide` の 1 行にする。理由の例外と一覧の聞き方を決まりだけに絞る
- [x] `.claude/skills/board-loop/SKILL.md`・`rules.md`・`.claude/agents/board-reviewer.md` の「使わない口」に `ai-board decide` を足す

### 4. ドキュメント・仕様・ADR

- [x] `CLAUDE.md` の CLI の一覧・書き込み境界・ハードルールの「CLI は構造で強制している」の段落を直す
- [x] `README.md` と `docs/architecture.md` の、`board-decide` がサーバを起動する説明・`--pid-file`・人の判断の入口の説明を直す
- [x] `docs/specs/card-review-authority/spec.md` の書ける主体を直す
- [x] `docs/adr/0007-board-decide.md` を今の形に書き直す（`adr` のスキル）

## AI レビュー

- [x] `src/board/cli/decide-cli.ts:126` の `parseArgs` は、知らないフラグを `true` として受け、余分な位置引数も黙って捨てる。`decide skip foo --gate plan --remov` は `--remove` の打ち間違いが無視され、飛ばす宣言を外さずに入れる（計画レビューのカードなら提出がそのまま承認扱いになり実装中へ進む）。`decide approve foo --reson "…"` は理由の空の 承認 を書いて 0 で終わる。サブコマンドごとに受けるフラグ（`approve` / `reject` / `abort` は `--reason`、`skip` は `--gate` と `--remove`、`move` / `move-divider` は `--after` と `--before`、`start` / `unstart` は無し）と位置引数の数（`move-divider` は 0、ほかは 1）を決め、外れたらボードを読む前に終了コード 1 で拒む。打ち間違えたフラグと余分な位置引数が拒まれ、何も書かないテストを `src/board/cli/__tests__/decide-cli.test.ts` に足す
- [x] `src/board/cli/decide-cli.ts:111` の `isDecideCommand` は `command in HANDLERS` で、`:96` の `HANDLERS[command]` も自分のプロパティかを見ないので、`constructor` / `toString` / `__proto__` がサブコマンドとして通る。`decide constructor x` は `src/cli-main.ts` の `runDecide` でデータ用ブランチの取り直しと全カードの PR の問い合わせ（PR 番号の書き戻しの push を含む）を起こしたうえで、`Object` を呼んで返したオブジェクトを終了コードにする。`src/board/cli/pr-cli.ts:81` と同じく `Object.hasOwn(HANDLERS, command)` で両方を確かめ、`constructor` が使い方を出して 1 で終わるテストを足す

### 見送った指摘

- `src/board/cli/decide-cli.ts:181` で、確かめたボードと書き込みの間に別の者がカードを書くと、`transact` の取り直しや push の拒否からのやり直しは `decisionsFor` を確かめ直さずに書く。計画の Risks で「画面と同じ広さの窓」として受け入れており、`## レビュー` は追記なので消えないため見送る
- `decide move <id> --after none --before none` は `src/cards/usecases/commands/move-in-order.ts:65` で何も書かないが、`src/board/cli/decide-cli.ts:329` は「並べ替えました」と出す。画面はこの組を送らず、カードも壊れないため見送る
- `src/cli-main.ts:285` で、データ用ブランチを取り直せない（offline）ときも警告だけで全カードの PR を問い合わせてから、書き込みで失敗する。最後は失敗を出して 1 で終わり、遅くなるだけなので見送る
- `src/cli-main.ts:289` で、PR の状態に依らない `move` / `move-divider` / `skip` も全カードの PR を問い合わせ、書いた後にもう一度ボードを導出する。計画の Decisions が「`status` と同じ組み立て」としており、速さだけの話なので見送る
- `src/board/cli/decide-cli.ts:114` の `parseArgs` は `src/cards/cli/card-cli.ts` の `parseCommandArgs` とほぼ同じ写しである。振る舞いを変えない重複なので見送る
- 人の API（`POST /api/cards/:id/reviews` など）は `decisionsFor` / `droppableStages` を確かめず、出せない判断も書ける。人の API の変更は計画の Non-Goals なので見送る

### 人に判断してほしいこと

- `src/board/cli/decide-cli.ts:243` の `start` / `unstart` は GitHub に繋がるかを見ずに `stage` と `droppableStages` で確かめるが、どちらも PR の状態に依る（`src/board/services/stage-resolver.ts:149` のルール 4 は Draft の PR を計画の成果物として計画レビューを立てる）。GitHub に繋がらず、計画ファイルが PR のブランチにしか無いと、計画レビューのカードが計画提案中（下限はアイデア）に見え、`decide unstart` が `startedAt` を消せてしまう（後で否決されるとアイデアへ落ちる）。計画の Decisions と人が承認した (2)「繋がらないときは承認 / 否決 / 中止だけ拒む」の前提（着手は PR の状態に依らない）と食い違う。繋がらないときに `start` / `unstart` も拒むか、`unstart` だけ拒むか、今のままにするかを人が決める（直すなら README の 324 行目も直す）
- `src/board/cli/decide-cli.ts:162` の、GitHub に繋がらないときに承認 / 否決 / 中止を拒む決まりは、`config.yaml` に `github:` が無いリポジトリ（`forge` が `disabled`）では常に当たり、チャットからは承認 / 否決 / 中止を一切書けなくなる（前の、人の API を叩く手順では書けた）。また `src/infrastructure/forge-poller.ts:110` は 1 枚のカードの PR の取得に失敗しただけで接続全体を `error` にするので、無関係な 1 枚のせいで全カードの判断が止まる。ループが同じ条件で止まる（README の 391 行目）のと揃っているとして今のままにするか、`disabled` のときは書けるようにするかを人が決める
