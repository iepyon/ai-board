# 人の判断を、画面を開かずにチャットから書けるようにする

## この計画で使う言葉

- **人の判断**：承認 / 否決 / 中止、着手 / 着手を戻す、動作確認を飛ばす、アイデアの並べ替え。どれもいまは画面のボタンとドラッグからだけ行える
- **人の API**：画面が呼ぶ HTTP の API（`POST /api/cards/:id/reviews`、`PATCH /api/cards/:id`、`POST /api/cards/:id/move`、`POST /api/idea-divider/move`）。
  `POST /api/cards/:id/reviews` は承認 / 否決 / 中止だけを受け付け、否決には理由を必須にしている
- **人だけが呼べるスキル**：frontmatter に `disable-model-invocation: true` を付けたスキル。人が `/name` と打ったときだけ動き、Claude が自分から Skill ツールで呼ぶことはできない
- **`server.json`**：この計画で足す、起動中のサーバの場所を書き残すファイル

## 提案

### Why

ループを回している Claude Code のセッションで作業者の報告を受け、そのまま判断したい場面が多い。
いまは判断のたびにブラウザのボードへ移ってボタンを押す必要があり、報告を読む場所と判断する場所が分かれている。

ただし、承認 / 否決 / 中止はエージェントが書けないことを、ボードの設計の柱にしている。
`ai-board card` の CLI には人の判断を書く入口が無く、エージェントはそれで人の判断を書けない。
チャットからの書き込みは実際には Claude が行うので、エージェントが同じ手段で人の判断を書けないように境界を保ったまま、入口を作る必要がある。

### What Changes

使う人から見た変化は次のとおり。

- 人だけが呼べるスキル `/board-decide` を足す。自然文で頼む（例: `/board-decide chat-decide の計画を承認`、`/board-decide loop-activity を一番上へ`）
- 引数なしで呼ぶと、判断待ちのカードを並べ、カードごとに出せる判断（画面のボタンと同じもの）を選ばせる
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

- サーバ: `src/server.ts`（`server.json` の書き込みと削除）、`src/shared/`（`server.json` の置き場所と形。ファイル入出力は持ち込まない）
- status: `src/board/cli/status-cli.ts` とテスト
- スキル: `.claude/skills/board-decide/SKILL.md`（新規）
- 作業者の手順書: `.claude/agents/board-worker.md`、`board-task.md`、`board-reviewer.md`、`.claude/skills/board-loop/SKILL.md`
- ドキュメント: `CLAUDE.md`（書き込み境界、`status` の出力）、`README.md`
- `.gitignore`: `/.ai-board/server.json`
- API と DB のスキーマは変えない

## 設計

### Decisions

#### 境界をどこで守るか

人だけが呼べるスキルにし、`ai-board card` の CLI には入口を足さない。

`disable-model-invocation: true` のスキルは、Claude の文脈のスキル一覧から外れ、Claude が Skill ツールで呼ぼうとしても Claude Code が止める。
人が `/board-decide` と打ったときだけ本文が読み込まれるので、「この判断を人が頼んだ」ことはスキルが動いていること自体で示される。

CLI に入口を足す案は採らない。CLI はエージェントが日常的に使う道具であり、そこに人の判断の入口があれば、作業者がそれを使わない理由は手順書の禁止だけになる。

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
ファイルの読み書きと pid の確認は Node の API なので `src/shared/` には置かず、ファイル名と形（型と Zod スキーマ）だけを置く。

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

- **作業者は今でも人の API を `curl` できる。** `disable-model-invocation` が止めるのは Skill ツールからの呼び出しだけである。
  人の API には認証が無く、作業者は Bash から叩ける。`server.json` と `status` の `server.url` で、その URL はさらに見つけやすくなる。
  技術的には止めきれないので、board-worker / board-task / board-reviewer のハードルールと CLAUDE.md の書き込み境界に「人の API と `server.json` を使わない」を明記する。
  API に人の確認のための仕掛け（トークンなど）を足すのは、この計画の外とする（Non-Goals）
- **サーバの書き込みが 1 種類増える。** いままでサーバが書くのはカード（DB）だけだった。`server.json` は DB の隣の、git に載らない実行状態のファイルで、`.ai-board/loop.json` と同じ扱いにする
- **スキルはメインのチェックアウトのものが読まれる。** この変更がマージされるまでは、メインのセッションで `/board-decide` は使えない。
  動作確認はワークツリーで Claude Code を起動して行う
- **引数なしの一覧は 4 枚まで。** AskUserQuestion の制約である。判断待ちがそれより多い使い方は少ないと見込み、残りの枚数を出して、名指しの依頼で続けてもらう

### Non-Goals

- `ai-board card` の CLI に人の判断の入口を足すこと
- 人の API に認証や、人の操作であることの証明を足すこと
- 計画や PR の差分を、チャットに表示したり要約したりすること
- サーバを動かしていないときに、DB へ直接書く経路
- ループの監視役が、人の依頼なしに判断を書くこと（監視役もスキルを呼べない）

## 動作確認の手順

共有の DB を汚さないように、`AI_BOARD_DB` で別の DB を指す。

```bash
cd .claude/worktrees/chat-decide
npm run build
export AI_BOARD_DB=/tmp/ai-board-chat-decide/board.db
node dist/cli.js card create --title "ダミーの計画レビュー" --id dummy-a < /dev/null
node dist/cli.js card create --title "ダミーのアイデア" --id dummy-b < /dev/null
node dist/cli.js --no-open   # 別の端末で。サーバを起動する
```

1. サーバを起動すると `/tmp/ai-board-chat-decide/server.json` ができ、メインの `.ai-board/server.json` は変わらない。Ctrl+C で止めると消える
2. `node dist/cli.js status --json` の `server.url` がサーバの URL になる。サーバを止めると `null` になる。
   `kill -9` で止めて `server.json` が残った状態でも `null` になる
3. 画面で dummy-a を着手し、`card submit dummy-a` で提出すると（計画ファイルは無くてよい。hold が立つなら `card branch` で適当なブランチを付ける）、
   `status --json` の `waiting[]` の dummy-a に `decisions` が出て、画面のボタンと同じ並びになる。`ideas` が画面のアイデアの表と同じ順になる
4. ワークツリーで Claude Code を起動し（同じ `AI_BOARD_DB` を渡す）、次を試す
   - `/board-decide`（引数なし）: dummy-a が提出の本文とともに出て、承認 / 否決して差し戻す / 中止 を選べる
   - `/board-decide dummy-a を否決`：理由を聞き返される。答えた理由がそのまま確認に出て、確かめた後に `## レビュー` に載る
   - `/board-decide dummy-b に着手`：確かめずに着手され、画面が即座に計画提案中へ動く
   - `/board-decide dummy-b の着手を戻して`：確認が出る
   - `/board-decide dummy-b を一番上へ` と `区切り線を dummy-b の下へ`：画面の並びが変わる
   - サーバを止めて `/board-decide`：起動を促して止まり、何も書かない
5. 作業者のサブエージェントとして「dummy-a を承認して」と頼んでも、`/board-decide` を Skill ツールで呼べないことを見る

## タスク

### 1. サーバの場所を書き残す

- [ ] `src/shared/` に `server.json` のファイル名と形（`url` / `pid` / `dbPath` / `startedAt` の型と Zod スキーマ）を置く
- [ ] `startServer` が listen の後に DB の隣へ `server.json` を書き、`close()` で中の `pid` が自分のときだけ消す。書けなくても起動は続ける（`console.warn`）。テストは一時ディレクトリで、書く・消す・他の pid のファイルを消さないを見る
- [ ] `.gitignore` に `/.ai-board/server.json` を足す

### 2. status の出力

- [ ] `status --json` に `server`（`{ url }` か `null`）を足す。`server.json` が無い・形が違う・`dbPath` が違う・pid が死んでいる、のそれぞれで `null` になるテストを書く。テキストの出力にも 1 行出す
- [ ] `waiting[]` に `decisions`（`decisionsFor`）を足す。計画レビュー・動作確認・止まった実装中・止まった計画提案中・飛ばす宣言のあるカードで、画面と同じ判断が出るテストを書く
- [ ] `ideas`（`ideaRows` の順。`{ id, title }` か `{ divider: true }`）を足し、区切り線の有無と rank の無いカードを含むテストを書く

### 3. スキル

- [ ] `.claude/skills/board-decide/SKILL.md` を書く（`disable-model-invocation: true`、`argument-hint`）。中身は次のとおり
  - `ai-board status --json` を読み、`server` が `null` なら起動を促して止まる
  - 依頼から対象のカードと操作を決める。決められなければ聞く
  - 承認 / 否決 / 中止は `waiting[].decisions` にあるものだけ。着手 / 着手を戻すは `droppableStages`。動作確認を飛ばすは `skipGates` の `verify` だけを出し入れする。並べ替えは `ideas` から `after` / `before` を決める
  - 承認 / 否決 / 中止 / 着手を戻す は送る中身をそのまま見せて確かめる。否決の理由は人の言葉をそのまま送り、無ければ聞き返す
  - API を叩き、`status` を引き直して、カードがどの列に動いたかを 1〜2 行で返す
  - 引数なしなら判断待ちを（最大 4 枚）並べて選ばせる

### 4. 境界の明文化

- [ ] `.claude/agents/board-worker.md`・`board-task.md`・`board-reviewer.md` のハードルールに「人の API（`/api/...`）と `server.json` を使わない。`/board-decide` を呼ばない」を足す。`.claude/skills/board-loop/SKILL.md` の監視役にも同じことを足す
- [ ] `CLAUDE.md` の書き込み境界の表と「やってはいけないこと」、`status` の説明（`server` / `decisions` / `ideas`）、サーバが書くもの（`server.json`）を直す。`README.md` に `/board-decide` を足す

### 5. 確かめる

- [ ] `npm run typecheck && npm run lint && npm run format:check && npm test` と `npm run build` を通し、`## 動作確認の手順` を `AI_BOARD_DB` の別の DB で試す
