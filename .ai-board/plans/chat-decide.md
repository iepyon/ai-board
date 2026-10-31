# 人の判断を、画面を開かずにチャットから書けるようにする

## この計画で使う言葉

- **人の判断**：承認 / 否決 / 中止、着手 / 着手を戻す、動作確認を飛ばす、アイデアの並べ替え。どれもいまは画面のボタンとドラッグからだけ行える
- **人の API**：画面が呼ぶ HTTP の API（`POST /api/cards/:id/reviews`、`PATCH /api/cards/:id`、`POST /api/cards/:id/move`、`POST /api/idea-divider/move`）。
  `POST /api/cards/:id/reviews` は承認 / 否決 / 中止だけを受け付け、否決には理由を必須にしている
- **`board-decide` のスキル**：この計画で足す、人に頼まれた判断を人の API で書くための手順書。人がチャットで頼めば Claude が呼び、`/board-decide` と打って明示的にも呼べる
- **`server.json`**：この計画で足す、起動中のサーバの場所を書き残すファイル

## 提案

### Why

ループを回している Claude Code のセッションで作業者の報告を受け、そのまま判断したい場面が多い。
いまは判断のたびにブラウザのボードへ移ってボタンを押す必要があり、報告を読む場所と判断する場所が分かれている。

ただし、ボードは「エージェントが自分の判断で人の判断を書かない」ことを設計の柱にしている（`CLAUDE.md` の書き込み境界、作業者と監視役の「人の判断は代行しない」）。
`ai-board card` の CLI には人の判断を書く入口が無く、作業者はそれで人の判断を書けない。
チャットからの書き込みは実際には Claude が行う。そこで「人がこの会話で頼んだときに、Claude が代わりに書く」ことは認め、
作業者が自分の判断で書くことは引き続き認めない、という線を引き直す。

### What Changes

使う人から見た変化は次のとおり。

- スキル `board-decide` を足す。チャットで頼めば動く（例:「chat-decide の計画を承認して」「loop-activity を一番上へ」）。`/board-decide chat-decide の計画を承認` と明示的にも呼べる
- 「判断待ちを見せて」と頼むか、引数なしで `/board-decide` を呼ぶと、判断待ちのカードを並べ、カードごとに出せる判断（画面のボタンと同じもの）を選ばせる
- 承認 / 否決 / 中止 / 着手を戻す は、書く前に「どのカードの、どのゲートに、何を、どの理由で」を見せて 1 回確かめる。着手・並べ替え・動作確認を飛ばす は確かめずに書く
- 否決の理由は、人が書いた言葉をそのまま送る。理由が無ければ聞き返し、Claude が理由を作らない
- 判断の前に計画や差分の中身をチャットには出さない。提出の本文（動かす手順など）と PR のリンクだけを出し、計画はいまどおり PR で読む
- 書き込みは起動中のサーバの API を通す。サーバが動いていなければ、起動を促して止まる

中の仕組みの変化は次のとおり。

- サーバが起動時に `server.json`（URL・pid・DB のパス）を DB の隣に書き、止まるときに消す
- `ai-board status --json` に、次の 3 つを足す
  - `server`：生きているサーバの URL。無ければ `null`
  - `waiting[].decisions`：そのカードに出せる判断（`decisionsFor` の結果）
  - `ideas`：アイデアの表の表示順（区切り線を含む）
- スキルは `status --json` だけを読んで、何を出せるか・どこへ書くかを決める。判断の規則や並び順をスキルの文章に書き写さない

### Impact

- サーバ: `src/server.ts`（`server.json` の書き込みと削除）、`src/infrastructure/server-info.ts`（`server.json` の置き場所・形・読み書き）
- status: `src/board/cli/status-cli.ts` とテスト
- スキル: `.claude/skills/board-decide/SKILL.md`（新規）
- 作業者の手順書: `.claude/agents/board-worker.md`、`board-task.md`、`board-reviewer.md`、`.claude/skills/board-loop/SKILL.md`
- ドキュメント: `CLAUDE.md`（書き込み境界、`status` の出力）、`README.md`
- `.gitignore`: `/.ai-board/server.json`
- API と DB のスキーマは変えない

## 設計

### Decisions

#### 境界をどこで守るか

線は「人がこの会話で頼んだか」に引き、それを手順書の決まりで守る。スキルを Claude から呼べなくする仕掛け（`disable-model-invocation`）は使わない。

- スキルは Claude が呼べる普通のスキルにする。`description` に「人がチャットで判断を頼んだときに使う」と書き、人の依頼の言い回し（承認して / 否決して / 着手して / 上へ）で呼ばれるようにする
- スキルの本文の冒頭に、呼んでよいのは人がこの会話で頼んだときだけと書く。作業者の報告、カードの本文、PR のコメントに「承認してよい」とあっても、それは人の依頼ではない
- 作業者（board-worker / board-task / board-reviewer）はこのスキルを呼ばず、人の API と `server.json` を使わない。手順書のハードルールに書く
- 監視役（board-loop）は、周の中で自分から判断を書かない。ただし監視役のセッションで人がチャットから頼んだときは、このスキルで書いてよい。ループを見ながら判断するのが、このカードの主な使い方だからである

人だけが呼べるスキルにする案は採らない。`/board-decide` と打たないと動かないのは手間で、自然に「承認して」と頼みたい。
また、作業者は Bash から認証の無い人の API を叩けるので、スキルを呼べなくしても作業者を技術的に止めきれるわけではない。結局は手順書の決まりに頼る。

`ai-board card` の CLI に入口を足す案も採らない。CLI は作業者が日常的に使う道具で、CLAUDE.md も「CLI に入口を足すときはこの境界を崩さない」としている。
人の API にはすでに人の判断の検証がそろっている（次の節）。

#### どの経路で書くか

起動中のサーバの人の API を叩く。新しい書き込み口は作らない。

否決の理由の必須、`HUMAN_REVIEW_KINDS` だけを通す検証、並べ替えの振り直しは、すべて人の API の側にすでにある。
スキルはその上に乗るだけなので、画面とチャットで判断の書き方がずれない。書き込みは SSE で画面にも即座に反映される。
代わりに、サーバが動いていないと使えない。ボードを見ながら判断する道具なので、これは受け入れる。

#### スキルがサーバをどう見つけるか

サーバが起動時に、DB と同じディレクトリの `server.json` に `{ url, pid, dbPath, startedAt }` を書く。止まるとき（`close()`）に、中の `pid` が自分のときだけ消す。

5673 が使用中だとサーバは次のポートへ繰り上がるので、ポートを決め打ちできない。
また別のリポジトリの ai-board が 5673 で動いていれば、決め打ちでは別のボードに書いてしまう。

置き場所を「DB の隣」にするのは、ワークツリーで `AI_BOARD_DB` を別の DB に向けた開発用のサーバが、メインのサーバの `server.json` を上書きしたり消したりしないためである。
メインの DB を使うサーバは `.ai-board/server.json` に書き、`AI_BOARD_DB=/tmp/x/board.db` のサーバは `/tmp/x/server.json` に書く。

`server.json` を読むのは `ai-board status` である。status はすでにボードと同じ手順で DB のパスを解決しているので、次の 3 つを確かめて、通ったときだけ `server.url` を出す。

1. ファイルがあり、形が正しい
2. 中の `dbPath` が自分の解決した DB のパスと一致する
3. `pid` のプロセスが生きている（`process.kill(pid, 0)`）

落ちたサーバが残したファイルは 3 で外れる。`tsx watch` の再起動は前のプロセスを止めてから次を起こすので、次のプロセスが上書きする。
ファイルの読み書きと pid の確認は Node の API で、画面からは使わないので、形（型と Zod スキーマ）も含めて `src/infrastructure/server-info.ts` に置く。

#### 出せる判断を、どこから知るか

`status --json` の `waiting[]` に `decisions`（`decisionsFor` の結果。`gate` / `kind` / `label` / `reasonRequired`）を足す。

スキルの文章に「計画レビューのカードには 承認 / 否決 / 中止」といった規則を書き写すと、`decisionsFor` と二重管理になり、いつかずれる。
画面と同じ関数の結果をそのまま読ませれば、チャットで出せる判断は画面のボタンと常に一致する。

着手と着手を戻すは、`status --json` の `cards[]` がすでに持つ `droppableStages` で決める（画面の「着手」「着手を戻す」のボタンと同じ条件）。
`droppableStages` に `planning` があれば着手でき、`idea` があれば着手を戻せる。サーバの `PATCH` はこの下限を検査しないので、スキルが必ず見る。

動作確認を飛ばすは、`skipGates` が配列ごとの置き換えなので、`cards[]` の現在値を読み、`verify` だけを出し入れして送る。`plan` には触れない（画面のチェックボックスと同じ範囲）。

#### 並べ替えの位置をどう決めるか

`status --json` に `ideas` を足す。画面が使う `ideaRows`（`src/shared/dashboard-sections.ts`）をそのまま通し、`{ id, title }` か `{ divider: true }` の並びで出す。

並び順は全カードと区切り線で 1 本で、アイデアの表はその部分列である。`card list` の rank 順から位置を推し量ると、区切り線の位置と rank を持たないカードの扱いを取り違える。
スキルは `ideas` の並びの上で「どこへ置くか」を決め、その直前と直後の項目を `after` / `before` にして送るだけにする（区切り線は `:divider`）。

#### 確認と理由の扱い

承認 / 否決 / 中止 / 着手を戻す は、AskUserQuestion で次を見せて 1 回確かめてから書く。

- カードの ID とタイトル、いまのステージ
- ゲートと種類（例: `plan 承認`、`verify 否決`）
- 送る理由の文字列そのもの

自然文の依頼から対象を取り違えると、取り消せない判断の記録が残る（`## レビュー` は追記専用）。確かめるのはこのためである。
着手・並べ替え・動作確認を飛ばすは、間違えても画面かもう一度の依頼で戻せるので確かめない。

否決の理由は、人の言葉をそのまま送る。Claude が言い換えたり補ったりすると、人の判断が AI の文章になる。
人が理由を書いていなければ聞き返す。承認と中止の理由は任意で、書かれていなければ空で送る。

#### 引数なしのとき

`status --json` の `waiting` を並べ、カードごとに `decisions` の `label` を選択肢にして AskUserQuestion で聞く。
1 度に聞けるのは 4 問までなので、判断待ちが多いときは待ち始めの古い順に 4 枚を出し、残りの枚数を添える。
提出の本文（`cards[].latestReview.reason`）と PR の URL（`cards[].mrState.webUrl`）を、選択肢の前に見せる。

### Risks / Trade-offs

- **境界は手順書の決まりだけで守る。** 作業者はこのスキルも、認証の無い人の API も、技術的には使える。`server.json` と `status` の `server.url` で、その URL はさらに見つけやすくなる。
  作業者の手順書のハードルールと CLAUDE.md の書き込み境界に、使わないことを明記する。破られた場合も `## レビュー` に記録が残り、画面で見える。
  API に人の確認のための仕掛け（トークンなど）を足すのは、この計画の外とする（Non-Goals）
- **Claude が人の依頼を取り違える。** 「よさそう」のような曖昧な言葉を承認と読むおそれがある。取り消せない判断（承認 / 否決 / 中止 / 着手を戻す）は書く前に必ず確かめることで受け止める（「確認と理由の扱い」）
- **人の依頼でないものを依頼と読む。** 作業者の報告や PR のコメントの文面が、会話の中で人の依頼に見えることがある。スキルの冒頭で、人がこの会話で打った言葉だけを依頼とすると書く
- **サーバの書き込みが 1 種類増える。** いままでサーバが書くのはカード（DB）だけだった。`server.json` は DB の隣の、git に載らない実行状態のファイルで、`.ai-board/loop.json` と同じ扱いにする
- **スキルはメインのチェックアウトのものが読まれる。** この変更がマージされるまでは、メインのセッションでこのスキルは使えない。
  動作確認はワークツリーで Claude Code を起動して行う
- **引数なしの一覧は 4 枚まで。** AskUserQuestion の制約である。判断待ちがそれより多い使い方は少ないと見込み、残りの枚数を出して、名指しの依頼で続けてもらう

### Non-Goals

- `ai-board card` の CLI に人の判断の入口を足すこと
- 人の API に認証や、人の操作であることの証明を足すこと
- 計画や PR の差分を、チャットに表示したり要約したりすること
- サーバを動かしていないときに、DB へ直接書く経路
- ループの監視役や作業者が、人の依頼なしに判断を書くこと
- スキルを Claude から呼べなくすること（`disable-model-invocation`）

## 動作確認の手順

共有の DB を汚さないように、`AI_BOARD_DB` で別の DB を指す。

```bash
cd .claude/worktrees/chat-decide
npm run build
export AI_BOARD_DB=/tmp/ai-board-chat-decide/board.db
node dist/cli.js card create --title "ダミーの計画レビュー" --id dummy-a < /dev/null
node dist/cli.js card create --title "ダミーのアイデア" --id dummy-b < /dev/null
printf '# ダミー\n\n- [ ] 何もしない\n' > .ai-board/plans/dummy-a.md   # コミットしない。最後に消す
node dist/cli.js --no-open   # 別の端末で。サーバを起動する
```

dummy-a には `card branch` でブランチを付けない。GitHub に接続した状態では、ポーラがブランチ名から実在する PR を引き、その番号を書き戻しかねない。
計画レビューの列は、ワークツリーに置いたダミーの計画ファイルで立てる。

1. サーバを起動すると `/tmp/ai-board-chat-decide/server.json` ができ、メインの `.ai-board/server.json` は変わらない。Ctrl+C で止めると消える
2. `node dist/cli.js status --json` の `server.url` がサーバの URL になる。サーバを止めると `null` になる。
   `kill -9` で止めて `server.json` が残った状態でも `null` になる
3. 画面で dummy-a を着手し、`card submit dummy-a` で提出すると、dummy-a は計画レビューに出る。
   `status --json` の `waiting[]` の dummy-a に `decisions` が出て、画面のボタンと同じ並び（承認 / 否決して差し戻す / 中止）になる。`ideas` が画面のアイデアの表と同じ順になる
4. ワークツリーで Claude Code を起動し（同じ `AI_BOARD_DB` を渡す）、次を試す
   - `/board-decide`（引数なし）と「判断待ちを見せて」: dummy-a が提出の本文とともに出て、承認 / 否決して差し戻す / 中止 を選べる
   - 「dummy-a を否決して」（スラッシュなし）: スキルが呼ばれ、理由を聞き返される。答えた理由がそのまま確認に出て、確かめた後に `## レビュー` に載る
   - 「dummy-b に着手して」: 確かめずに着手され、画面が即座に計画提案中へ動く
   - 「dummy-b の着手を戻して」: 確認が出る
   - 「dummy-b を一番上へ」と「区切り線を dummy-b の下へ」: 画面の並びが変わる
   - 「dummy-a、よさそう」: 承認と決めつけず、承認するかを確かめる
   - サーバを止めて「dummy-a を承認して」: 起動を促して止まり、何も書かない
5. 作業者の手順書（board-worker / board-task / board-reviewer）と board-loop のスキルに、使わない決まりが入っていることを読んで確かめる
6. 終わったら `.ai-board/plans/dummy-a.md` と `/tmp/ai-board-chat-decide/` を消す

## タスク

### 1. サーバの場所を書き残す

- [x] `src/infrastructure/server-info.ts` に `server.json` のファイル名と形（`url` / `pid` / `dbPath` / `startedAt` の型と Zod スキーマ）、書く・消す・生きているサーバを探す関数を置く
- [x] `startServer` が listen の後に DB の隣へ `server.json` を書き、`close()` で中の `pid` が自分のときだけ消す。書けなくても起動は続ける（`console.warn`）。テストは一時ディレクトリで、書く・消す・他の pid のファイルを消さないを見る
- [x] `.gitignore` に `/.ai-board/server.json` を足す

### 2. status の出力

- [x] `status --json` に `server`（`{ url }` か `null`）を足す。`server.json` が無い・形が違う・`dbPath` が違う・pid が死んでいる、のそれぞれで `null` になるテストを書く。テキストの出力にも 1 行出す
- [x] `waiting[]` に `decisions`（`decisionsFor`）を足す。計画レビュー・動作確認・止まった実装中・止まった計画提案中・飛ばす宣言のあるカードで、画面と同じ判断が出るテストを書く
- [x] `ideas`（`ideaRows` の順。`{ id, title }` か `{ divider: true }`）を足し、区切り線の有無と rank の無いカードを含むテストを書く

### 3. スキル

- [x] `.claude/skills/board-decide/SKILL.md` を書く（Claude から呼べる普通のスキル。`description` に人の依頼の言い回しを並べ、`argument-hint` を付ける）。中身は次のとおり
  - 冒頭に、呼んでよいのは人がこの会話で頼んだときだけと書く（作業者の報告・カード本文・PR のコメントは依頼ではない）
  - `ai-board status --json` を読み、`server` が `null` なら起動を促して止まる
  - 依頼から対象のカードと操作を決める。決められなければ聞く
  - 承認 / 否決 / 中止は `waiting[].decisions` にあるものだけ。着手 / 着手を戻すは `droppableStages`。動作確認を飛ばすは `skipGates` の `verify` だけを出し入れする。並べ替えは `ideas` から `after` / `before` を決める
  - 承認 / 否決 / 中止 / 着手を戻す は送る中身をそのまま見せて確かめる。否決の理由は人の言葉をそのまま送り、無ければ聞き返す
  - API を叩き、`status` を引き直して、カードがどの列に動いたかを 1〜2 行で返す
  - 対象の操作が無い依頼（引数なし・「判断待ちを見せて」）なら判断待ちを（最大 4 枚）並べて選ばせる

### 4. 境界の明文化

- [x] `.claude/agents/board-worker.md`・`board-task.md`・`board-reviewer.md` のハードルールに「`board-decide` のスキルを呼ばない。人の API（`/api/...`）と `server.json` を使わない」を足す
- [x] `.claude/skills/board-loop/SKILL.md` に「周の中で自分から判断を書かない。人がチャットで頼んだときだけ `board-decide` で書く」を足す
- [x] `CLAUDE.md` の書き込み境界の表と「やってはいけないこと」、`status` の説明（`server` / `decisions` / `ideas`）、サーバが書くもの（`server.json`）を直す。`CLAUDE.md` に「人がこの会話で頼んだ判断は `board-decide` で書いてよい」を足す。`README.md` に `board-decide` を足す

### 5. 確かめる

- [x] `npm run typecheck && npm run lint && npm run format:check && npm test` と `npm run build` を通し、`## 動作確認の手順` を `AI_BOARD_DB` の別の DB で試す

## AI レビュー

- [ ] `.claude/skills/board-decide/SKILL.md:62` の否決の理由の聞き返しは、AskUserQuestion の選択肢を「理由を書く」の 1 つだけにしているが、AskUserQuestion は 1 問に選択肢を 2 つ以上要るので呼び出しが失敗する。理由は AskUserQuestion を使わずにチャットで聞き返し、人が次に打った言葉をそのまま理由にする、と書き改める（理由を作らない決まりはそのまま残す）
- [ ] `.claude/skills/board-decide/SKILL.md:119-124`（手順 6）は、カードの `decisions` の `label` だけを選択肢にするので、`decisions` が 1 つだけのカード（成果物が見えずに止まった計画提案中は「中止する」だけ）で選択肢が 1 つになり AskUserQuestion が失敗する。また 123 行の「手順 3 の確認を経ずに書いてよい」は、計画の Decisions「確認と理由の扱い」（承認 / 否決 / 中止は送る理由の文字列を見せて 1 回確かめてから書く）と食い違う。各問いに「今は何もしない」の選択肢を必ず足し、選ばれた承認 / 否決 / 中止は手順 3 の確認（否決は理由を聞いてから）を経て書く、と書き改める

### 見送った指摘

- `src/infrastructure/server-info.ts:96` の `isProcessAlive` は pid の生存だけを見るので、落ちたサーバの pid が別のプロセスに再利用されると古い URL を返す（EPERM も生きているとみなす）。計画の Decisions が pid の生存確認を採っており、別のボードへ判断を書いてしまうには pid の再利用・同じポートでの別のボードの起動・同じカード ID が重なる必要があるので見送る。多くは接続の失敗で止まる
- `src/infrastructure/server-info.ts:74` の DB の一致を `path.resolve` の文字列で比べており、シンボリックリンクを解かない。サーバも status も同じ `resolvePaths` で DB のパスを決めるので通常は一致し、ずれても「サーバが無い」と安全側に止まるだけなので見送る
- `src/infrastructure/server-info.ts:41` の `server.json` を一時ファイルと rename を使わずに直接書いている。書いている瞬間に status が読んでも `server` が `null` になるだけで、引き直せば直るので見送る
- `src/board/cli/status-cli.ts` が `src/infrastructure/server-info.ts` の型 `ServerLocation` を import している。レイヤーの分け方の好みで、振る舞いに関わらないので見送る
- `src/board/cli/__tests__/status-cli.test.ts` に、タスク 2 で挙げた「止まった計画提案中（plan 保留）」と「飛ばす宣言のあるカード」の `decisions` のテストが無い。status は `decisionsFor` の結果をそのまま通しており、その 2 つは `src/shared/__tests__/dashboard-sections.test.ts` の `decisionsFor` のテストが見ているので見送る

### 人に判断してほしいこと

- `server.json` は DB ごとに 1 つなので、同じ DB を使うサーバが 2 つ動くと（例: メインの `ai-board` を動かしたまま、ワークツリーで共有の DB のまま `npm run dev` を動かす）後から起動した方が上書きする。後の方が止まると、前のサーバが動いているのに `status` の `server` が `null` になる。開発用の `src/index.ts` は止まるときに `close()` を呼ばないので、ファイルは死んだ pid のまま残る。計画の Decisions は別の DB を指すサーバの場合しか扱っていない。安全側（「サーバが無い」）に止まるだけとして受け入れるか、生きているサーバがあれば上書きしない・`src/index.ts` にも SIGINT / SIGTERM で `close()` を呼ぶ、などで直すかは人が決める
- `.claude/skills/board-decide/SKILL.md:23` はいつもメインのチェックアウトの `dist/cli.js` で `status --json` を読む。この変更がマージされるまではメインの `status` に `server` が無いので、`## 動作確認の手順` の 4（ワークツリーで Claude Code を起動して試す）ではスキルが「メインを更新して」と止まり、手順どおりに確かめられない。スキルが自分の入っているチェックアウトのビルドを使うように直すか、マージ後のメインを使う前提を残して動作確認の手順の方を直すかは人が決める
