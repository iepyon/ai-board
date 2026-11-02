# AI ループの 1 手ごとの履歴を残し、今触っているカードと 1 手の時間をボードで見せる

## この計画で使う言葉

- **監視役**：`/board-loop` のスキルを動かすセッション。`ai-board status --json` の `next` を読み、サブエージェントに 1 手を渡す。
- **手**：監視役がサブエージェントに 1 回で渡す仕事（`plan` / `revise-plan` / `implement` / `revise-impl` / `ready`）。
- **1 手の記録**：監視役が手を渡してから、サブエージェントの完了の通知を受けるまでを 1 件にしたもの。
  どのループが、どのカードに、どの手を、いつ始めていつ終えたか、結果、トークン、時間を持つ。この計画で新しく作る。
- **ループの識別子**：監視役のセッションごとの名前。並べて回すループを見分けるために 1 手の記録に持たせる。
- **区間**：`stage-timeline` が導出する、カードが各工程にいた時間（`TimelineSegment`）。担当が人か AI かを持つ。
- **データ用ブランチ**：カードの正本を置く `origin` の `ai-board/data`。CLI とサーバは書くたびにコミットして push する。
- **品質ゲート**：`npm run typecheck && npm run lint && npm run format:check && npm test`。

## 提案

### Why

ボードはカードのステージを示すが、AI のループが今どのカードを触っているかは示さない。
`/loop` で間隔運転していると、ループが動いているのか、止まっているのか、どのカードで詰まっているのかを画面から知る手段が無く、ターミナルを覗くしかない。
ループを任せきりにするには、止まったことにすぐ気づけることが前提になる。

また `stage-timeline` で、カードが AI の区間にいた時間は取れるようになった。
しかし「AI が遅い」が、ループの間隔や並列度のせいで拾われるまで待っていたのか、作業そのものに時間がかかったのかは見分けられない。
1 手ごとの開始と終了が残っていれば、AI の区間を「ループが拾うまでの待ち」と「作業者が動いていた時間」に分けられる。

### What Changes

使う人から見た変化は次のとおり。

- 監視役は、サブエージェントに手を渡すときに `ai-board loop start` で開始を、完了の通知を受けたときに `ai-board loop finish` で終了・結果・トークン・時間を書く。
  1 手の記録はデータ用ブランチの `loop/` に置かれ、書くたびにコミットして push される
- 画面のトップバーに、ループが今触っているカードと手、始めてからの時間が出る。何も触っていなければ、最後の手が終わってからの時間が出る
- 今触られているカードには、判断待ち / AI 作業中の区画のカードの行に「AI 稼働中」の印が付く
- カードの詳細パネルに「ループの手」の欄が増え、そのカードに渡された手の一覧（開始時刻、手と段、作業者、時間、トークン、結果）が出る
- `ai-board status` の人向けの出力と `--html` にも、今触っているカードが出る。`--json` には履歴そのものが載る
- `GET /api/board` と `status --json` の区間の並びで、AI の区間が「待ち」と「作業」の小区間に分かれる。グラフにするのは `bottleneck-chart` のカードで、このカードでは画面に出さない

変わらないこと:

- ステージの導出と次の一手（`pickNextAction`）は 1 手の記録を読まない。ループの状態はカードの属性ではない
- カードのファイル（`cards/`）と `order.yaml` の形。データ用ブランチの形の版（`ai-board-data.yaml`）も上げない（Decisions）
- サブエージェント（`board-planner` / `board-worker` / `board-reviewer`）の手順。1 手の記録を書くのは監視役だけ

### Impact

- データ用ブランチ: `loop/` を足す（`src/infrastructure/data-store.ts` の `DATA_PATHS`）
- 新しい型と純関数: `src/shared/loop-step.ts`（1 手の記録の型と表示用の語）、`src/shared/loop-activity.ts`（今触っているカード・最後の手の要約）、
  `src/board/services/timeline-phases.ts`（AI の区間を待ちと作業に分ける）
- 読み書き: `src/board/repositories/loop-history.repository.ts`（ファイルの形と読み書き）
- CLI: `src/board/cli/loop-cli.ts`（新規）、`src/cli-main.ts`（入口）、`src/board/cli/status-cli.ts` / `status-html.ts` / `status-describe.ts`
- 組み立て: `src/board/usecases/queries/get-board.query.ts`、`src/board/models/board-card.ts`、`src/board/composition.ts`、サーバの組み立て（`src/server.ts` など `createBoardDependencies` の呼び出し側）
- 画面: `src/web/types.ts`、`src/web/App.tsx`（トップバー）、`src/web/components/dashboard/parts.tsx`（印）、`src/web/components/detail/LoopSteps.tsx`（新規）、`src/web/components/CardDetail.tsx`、`src/web/styles.css`
- ループ: `.claude/skills/board-loop/SKILL.md`、`.claude/skills/board-loop/subagent-rules.md`
- ドキュメント: `CLAUDE.md`（書き込み境界の表と CLI の一覧）、`README.md`、`docs/architecture.md`、`docs/specs/board-timeline/spec.md`、`docs/specs/loop-activity/spec.md`（新規）
- API: `GET /api/board` に `loop`（今触っている手と最後に終えた時刻）が、各カードに `loopSteps` が、`timeline` の各区間に `phases` が増える。ローカル専用ツールで外部の利用者は無い

## 設計

### Decisions

#### 1 手の記録の形と置き場所

1 手の記録は、データ用ブランチの `loop/` に 1 件 1 ファイルの JSON で置く。

```
loop/<開始の時刻>.<ループの識別子>.json
```

時刻はカードの判断のファイル（`log/`）と同じ `toLogStamp` の形（`20261102T111406.000Z`）にし、同じ時刻と識別子が重なったら `-2` のように連番を付ける。
中身は次のとおり。

```json
{
  "loop": "8c00f2c6-5eb7-50c4-96d8-1ade0e29f793",
  "cardId": "loop-activity",
  "action": "implement",
  "step": "task",
  "agent": "board-worker-loop-activity-1114",
  "startedAt": "2026-11-02T11:14:06.000Z",
  "finishedAt": "2026-11-02T11:31:40.000Z",
  "result": "advanced",
  "tokens": 412345,
  "durationMs": 1054000
}
```

- 開始では `finishedAt` / `result` / `tokens` / `durationMs` を `null` にしてファイルを作り、終了で同じファイルにそれらを 1 度だけ埋める。終わった記録は書き換えない
- `result` は `advanced`（進めた）/ `held`（保留して止まった）/ `stopped`（止まった）/ `failed`（`Agent` が失敗した）/ `unknown`（報告に結果の語が無い）/ `interrupted`（途切れた）。
  最初の 3 つはサブエージェントの報告の `結果:` の語に 1 対 1 で対応する。表示の語は `src/shared/loop-step.ts` に置く
- 読めないファイル（JSON でない、項目が不正、ファイル名と中身の時刻が食い違う）は、カードと同じく警告して読み飛ばす。ボード全体を 500 にしない

カードの `log/` のように開始と終了を別のファイルにする案もあった。
1 ファイルにしたのは、終了を書くときに「そのループの終わっていない記録」を 1 つ探せば足り、読み手も組み立てが要らないからである。
書き込みは `DataStore.transact` の中で取り直した最新の状態に対して行うので、終了の書き込みが別のループの記録を壊すことは無い。

カードの中（`cards/<id>/`）には置かない。ループの状態はカードの属性ではなく、カードの書き込み境界（`card-cli.ts`）と混ぜないためである。
データ用ブランチに置くのは、人が 2026-11-02 に決めたとおり、クラウドのセッションが片付けられても残り、別の端末のボードからも見えるようにするためである。
1 手ごとに 2 つのコミットが増えるのは受け入れる。

#### 形の版は上げない

`loop/` はデータ用ブランチに足すだけで、`cards/` と `order.yaml` の形は変えないので、`ai-board-data.yaml` の版は 1 のままにする。
古い版の CLI は `DATA_PATHS` に `loop/` を持たないが、`git add` も `git clean -x` も `DATA_PATHS` の下だけを扱い、追跡済みの `loop/` のファイルは `reset --hard` で保たれる。
古い CLI がカードを書いても `loop/` は消えない。この前提はタスクのテストで確かめる。

版を上げると、メインのチェックアウトの古い CLI がカードを読めなくなり（`CLAUDE.md`）、ループ自身が止まる。

#### ループの識別子は監視役のセッション ID にする

監視役は `--loop` に Claude Code のセッション ID（環境変数 `CLAUDE_CODE_SESSION_ID`）を渡す。無ければ `local-<ホスト名>` にする。
セッション ID なら自動の要約で記憶が落ちても変わらず、後で Claude Code の会話の記録（`~/.claude/projects/` のログ）へ辿る手掛かりにもなる。
CLI は環境変数を読まず、`--loop` を必須にする（CLI の振る舞いを引数だけで決め、テストしやすくするため）。
識別子は `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` に合うものだけを受け付ける。ファイル名に入るためである。

並べて回すための宣言（原子的な取得や失効）はこのカードでは入れない（人の 2026-11-02 の判断）。
ただし識別子を持たせておけば、後のカードで「そのループの終わっていない記録」を宣言として読める。

#### CLI は `ai-board loop` を別に立て、カードを書けない形にする

```bash
ai-board loop start  --loop <id> --card <cardId> --action <手> [--step <task|review|close>] [--agent <name>]
ai-board loop finish --loop <id> --card <cardId> --result <advanced|held|stopped|failed|unknown> [--tokens <n>] [--duration-ms <n>]
```

- `loop-cli.ts` は、カードについては「その ID のカードがあるか」を読む関数だけを受け取り、カードのリポジトリの書き込みの口を持たない。
  書くのは `loop/` のファイルだけで、`card-cli.ts` の書き込み境界には入口を足さない
- `start` はカードが無ければ拒む（ID の打ち間違いで、どのカードにも付かない記録を残さない）。手と段は `next.action` / `next.step` と同じ値だけを受け付ける
- `start` のとき、同じループに終わっていない記録が残っていれば、それを `interrupted` で閉じてから新しい記録を作る（同じコミット）。
  1 つのループは 1 度に 1 手しか渡さないので、残っているのは前の手の終了を書き損ねたものである。残したままだと「今触っている」が嘘になる
- `finish` は、そのループの終わっていない記録を 1 つ選んで埋める。無いとき、または `--card` が食い違うときは拒んで 1 を返す。`interrupted` は人が渡す値として受け付けない
- どちらも `DataStore.transact` の 1 操作として走らせ、コミットのメッセージは `loop: <start|finish> <cardId> <手>` にする

#### 監視役は履歴の書き込みでループを止めない

1 手の記録はステージの導出にも次の一手にも使わない。オフラインや push の失敗で `ai-board loop` が失敗しても、監視役は 1 行で知らせて手を渡し続ける。
止めると、見るための記録のせいで本来の作業が止まる。

監視役はトークンと時間を、完了の通知の `usage`（`subagent_tokens` / `duration_ms`）から写す。サブエージェントは自分の使ったトークンを知らないので、書けるのは監視役だけである。
結果は報告の `結果:` の語を写し、どれにも当たらなければ `unknown`、`Agent` が失敗したら `failed` にする。

書き込み境界の表に「ループの監視役は `ai-board loop` 経由で `loop/` だけを書く。カードには書かない」を足す。
サブエージェントは `ai-board loop` を使わない（共通の決まりのハードルールに足す）。

#### ボードへの載せ方

`GetBoardQuery` が 1 手の記録を全部読み、次の 2 つにして返す。

- `Board.loop`: `{ running: LoopStep[]; lastFinishedAt: string | null }`。`running` は終わっていない記録で、ループごとに高々 1 件
- `BoardCard.loopSteps`: そのカードの記録を開始の時刻の順に並べたもの

トップバーと `status` に出す要約（「ループ: <カード> を <手> 中（12 分）」「ループ: 最後の手から 40 分」「ループ: 記録なし」）は、
`src/shared/loop-activity.ts` の純関数が `Board.loop` と `generatedAt` から作る。今の時刻は読まない（`generatedAt` までを数える）。
`src/web/` はテストの対象外なので、文言と時間の計算はこの純関数に寄せてテストする。

#### AI の区間を待ちと作業に分ける

`resolveTimeline` はそのままにし、その結果と 1 手の記録を受け取る純関数 `splitAiPhases`（`src/board/services/timeline-phases.ts`）を足す。
各区間に `phases: { kind: 'wait' | 'work'; start; end }[]` を付ける。

- 人の区間の `phases` は空
- AI の区間では、そのカードの 1 手の記録を区間の範囲で切り取り、重なった部分を `work`、区間の中のそれ以外を `wait` にする。
  `implement` の 1 区間に、タスク・レビュー・締めの 3 手が入れば、待ちと作業が交互に並ぶ
- 区間に重なる記録が 1 つも無ければ `phases` を空にする。記録を始める前のカードや、ループを使わずに人が手で進めたカードを、全部「待ち」と言い張らないためである
- 終わっていない区間・終わっていない記録は `end: null` のまま扱い、今の時刻を受け取らない（`resolveTimeline` と同じ）
- 記録どうしが重なれば 1 つの `work` につなぐ

`TimelineSegment` 自体に項目を足さず、`phases` を持つ型（`PhasedTimelineSegment`）を `src/shared/timeline.ts` に足して、`BoardCard.timeline` をそれにする。
`resolveTimeline` のテストを書き換えずに済み、区間の導出（痕跡だけから決まる）と分け方（1 手の記録を使う）が混ざらない。

### Risks / Trade-offs

- **データ用ブランチのコミットが増える。** 1 手ごとに 2 コミット。間隔運転で 1 日に数十から百程度になる。人が受け入れた（2026-11-02）
- **書き込みがロックを取り合う。** 監視役の `ai-board loop` と、サブエージェントの `ai-board card submit` が同時に走ると、片方がロックを待つ（5 秒）。
  順に走るので、実際に重なるのは並べて回したときだけで、待ち切れたら上の決まりどおり監視役は 1 行で知らせて続ける
- **終了を書き損ねる。** 監視役のセッションが落ちると、記録は終わらないまま残る。同じセッションが次の手を渡せば `interrupted` で閉じるが、
  セッションごと無くなれば残り続け、トップバーは「触っている」と出し続ける。始めてからの時間を必ず添えて、長すぎることに人が気づけるようにする。
  時刻での失効は宣言のカードで考える
- **トークンと時間は監視役の写しである。** 通知の形が変われば写せなくなる。そのときは `null` のまま残り、画面は「—」と出す
- **`status --json` が大きくなる。** 各カードに `loopSteps` が載る。監視役は `next` / `waiting` / `forge` だけを取り出して読むので、文脈は膨らまない

### Non-Goals

- 並べて回すための宣言、`pickNextAction` が宣言済みのカードを飛ばすこと、宣言の原子的な取得と失効（別のカードにする）
- 待ちと作業を分けた区間のグラフ（`bottleneck-chart`）。このカードはデータを API と `status --json` に出すまで
- 会話の記録（`~/.claude/projects/`）をボードから開くこと。識別子を残すだけにする
- サブエージェントが自分の進み具合（どの節を倒しているか）を書くこと
- 古い 1 手の記録を消す・畳むこと

## 動作確認の手順

共有のカードを汚さないよう、`AI_BOARD_DATA` でスクラッチパッドの試しのデータを指す（`.claude/skills/board-loop/subagent-rules.md` の「動かして確かめるとき」）。

1. 試しのデータを作り、カードを 1 枚起票する

   ```bash
   npm run build
   S=<スクラッチパッドの下の作業用ディレクトリ>
   git init --bare "$S/origin.git" && git clone "$S/origin.git" "$S/data"
   export AI_BOARD_DATA="$S/data"
   node dist/cli.js migrate --empty
   echo '## アイデア' | node dist/cli.js card create --title 'ループの試し' --id loop-try
   ```

2. `node dist/cli.js --no-open` でサーバを起動し、ブラウザでボードを開く。トップバーに「ループ: 記録なし」が出る
3. 別の端末で（同じ `AI_BOARD_DATA` のまま）開始を書く

   ```bash
   node dist/cli.js loop start --loop try-1 --card loop-try --action plan --agent board-planner-loop-try-1200
   ```

   - 1 分以内（データの取り直しの間隔）にトップバーが「ループ: ループの試し を plan 中（0 分）」になる
   - アイデアの表の `loop-try` の行に「AI 稼働中」の印が付く
   - 存在しないカード（`--card nope`）や不正な手（`--action foo`）では、拒まれて何も書かれない

4. 終了を書く

   ```bash
   node dist/cli.js loop finish --loop try-1 --card loop-try --result advanced --tokens 81234 --duration-ms 95000
   ```

   - トップバーが「ループ: 最後の手から 0 分」になり、印が消える
   - `loop-try` の詳細パネルの「ループの手」に、開始時刻・`plan`・`board-planner-loop-try-1200`・1 分 35 秒・81k・進めた の 1 行が出る
   - もう一度 `finish` すると、終わっていない記録が無いので拒まれる

5. `start` を 2 回続けて書く（2 回目は `--action revise-plan`）。1 回目の記録が「途切れた」で閉じ、2 回目が「触っている」になる
6. `node dist/cli.js status` と `node dist/cli.js status --html` に、今触っているカードの行が出る
7. 画面で `loop-try` を着手し、`card submit loop-try` などで AI の区間を作ってから、`status --json` の `cards[].timeline[].phases` で
   AI の区間が `wait` と `work` に分かれていることを見る（記録の無い区間は `phases: []`）
8. 試しのデータの `origin` に、1 手ごとに `loop: start ...` / `loop: finish ...` のコミットが積まれ、`cards/` に変化が無いことを `git -C "$S/origin.git" log --stat ai-board/data` で見る
9. サーバを止め、`unset AI_BOARD_DATA` してから作業用ディレクトリを消す

## タスク

### 1. 1 手の記録の型とファイルの読み書き

- [x] `src/shared/loop-step.ts` に 1 手の記録の型（`LoopStep`）、結果の値（`LOOP_RESULTS`）と表示の語、手・段の値の一覧を足す（手と段は `next-action.ts` / `impl-step.ts` の型と食い違わないよう、そちらから導くか型テストで縛る）
- [x] `src/board/repositories/loop-history.repository.ts` に、ファイル名の組み立てと解釈・JSON の検証（Zod）・全件の読み出し（読めないものは警告して飛ばす）・開始の書き込み（同じループの終わっていない記録を `interrupted` で閉じる）・終了の書き込みを置く。書き込みは `dataDir` を受け取る関数にし、`transact` の中から呼べる形にする
- [x] `src/infrastructure/data-store.ts` の `DATA_PATHS` に `loop` を足す
- [x] テスト: ファイル名の往復と連番、不正なファイルの読み飛ばし、`interrupted` で閉じる、終わった記録を書き換えない、`DATA_PATHS` に無い古い CLI の書き込み（`loop` を除いた `add` と `clean`）でも `loop/` が残ること

### 2. `ai-board loop` の CLI

- [x] `src/board/cli/loop-cli.ts` に `start` / `finish` と使い方を置く。カードについては存在を確かめる関数だけを受け取り、書き込みは `transact` の 1 操作にする。`--loop` の形、`--action` / `--step` / `--result` の値、`--tokens` / `--duration-ms` の整数を検査する
- [x] `src/cli-main.ts` に `loop` サブコマンドの入口と、全体の使い方の行を足す
- [x] テスト: 正常な開始と終了、存在しないカード・不正な値・終わっていない記録が無いとき・`--card` が食い違うときの拒否（何も書かない）、`interrupted` を渡せないこと、コミットのメッセージ

### 3. ボードと `status` に載せる

- [x] `src/shared/timeline.ts` に `TimelinePhase` と `PhasedTimelineSegment` を足し、`src/board/services/timeline-phases.ts` に `splitAiPhases` を置く。テスト: 人の区間は空、記録の無い AI の区間は空、待ちと作業が交互に並ぶ、区間の外にはみ出した記録を切る、重なった記録をつなぐ、終わっていない区間と記録
- [x] `src/shared/loop-activity.ts` に、`Board.loop` と `generatedAt` から要約の文言と経過時間を作る純関数と、カードが今触られているかを返す関数を置く。テスト: 触っている（1 件 / 複数のループ）、最後の手から、記録なし
- [x] `GetBoardQuery` に 1 手の記録の読み手を渡し、`Board.loop` と `BoardCard.loopSteps` と `phases` 付きの `timeline` を組み立てる。`createBoardDependencies` とその呼び出し側（サーバ・`status`）を合わせて直す
- [x] `status` の人向けの出力と `--html` に、今触っているカードの行（`loop-activity.ts` の文言）と、作業中のカードの「AI 稼働中」の印を出す。`status-cli` / `status-html` / `get-board.query` のテストを足す

### 4. 画面

- [ ] `src/web/types.ts` に `LoopStep` / `phases` / `Board.loop` / `BoardCard.loopSteps` を写す
- [ ] トップバー（`App.tsx`）に、`loop-activity.ts` の文言でループの様子を出す。始めてからの時間は `generatedAt` までで数える
- [ ] 判断待ち / AI 作業中の区画とアイデアの表のカードの行（`parts.tsx`）に「AI 稼働中」の印を付ける
- [ ] 詳細パネルに「ループの手」の欄（`detail/LoopSteps.tsx`）を足す。開始時刻・手と段・作業者・時間・トークン・結果を新しい順に並べ、値の無いものは「—」と出す。時間とトークンの書式は `src/shared/` の純関数にしてテストする

### 5. 監視役の手順書とドキュメント

- [ ] `.claude/skills/board-loop/SKILL.md` の手順 3 に、`Agent` を呼ぶ前の `ai-board loop start`（`--loop "${CLAUDE_CODE_SESSION_ID:-local-$(hostname)}"`、`--step` は `next.step` が null でなければ）を、
      手順 4 に、報告を伝える前の `ai-board loop finish`（結果の語の対応表、`usage` の写し方、`Agent` の失敗は `failed`）を足す。失敗してもループを止めないことと、ハードルールの「カードへの書き込みはしない」との関係を書く
- [ ] `.claude/skills/board-loop/subagent-rules.md` の呼び名の表とハードルールに、`ai-board loop` は監視役だけが使うことを足す
- [ ] `CLAUDE.md` の書き込み境界の表に監視役の行を、CLI の一覧に `ai-board loop` を足す
- [ ] `README.md` の AI ループの節と画面の節、`docs/architecture.md`（データ用ブランチの中身、1 手の記録の節、API、区間の並び）を直す
- [ ] `docs/specs/loop-activity/spec.md` を足し、`docs/specs/board-timeline/spec.md` に待ちと作業の分け方の要件を足す
