# サブエージェントを入れ子にせず、実装中の段も監視役が直接渡す

## この計画で使う言葉

- **監視役**：`/board-loop` のスキルを動かすセッション。`ai-board status --json` の `next` を読み、サブエージェントに 1 手を渡す。
- **段**：`implement` の手の中で、計画の状態から決まる区切り。archive 済み / タスクを倒す段 / レビューの段 / 締めの段 の 4 つ（`loop-impl-review` で決めたもの）。
- **入れ子**：サブエージェント（`board-worker`）の中から、さらにサブエージェント（`board-task` / `board-reviewer`）を立てる形。

## 提案

### Why

`loop-impl-review` で、`implement` の手を受けた `board-worker` が、タスクを倒す段では `board-task` を、レビューの段では `board-reviewer` を入れ子で立てる形にした。
手元のセッションでは動いたが、2026-11-01 にクラウドのセッションで `/loop 5m /board-loop` を回したところ、`node-lts` の `implement` で `board-worker` が止まった。
クラウドのセッションではサブエージェントが `Agent` の道具を持てず、`board-worker` が `board-task` を立てられなかった。
`.claude/agents/board-worker.md` は道具を絞っていないので、定義を直しても解決しない見込みである。

止まったカードは次の周でも `next` に選ばれるので、ループは毎周同じところで止まり、そのたびに約 7.6 万トークンを使う。
スマホの Claude Code からクラウドでボードを回す使い方（`issue-store`）では、実装中のカードを 1 枚も進められない。

サブエージェントを立てられるのは監視役（会話のトップ）だけ、という前提に寄せれば、手元でもクラウドでも同じ手順で回る。

### What Changes

使う人から見た変化は次のとおり。

- `ai-board status --json` の `next` に、`implement` のときだけ段（`step`）が載る。値は `task` / `review` / `close` / `null`（読めなかった）
- 監視役は `next.step` を見て、`task` なら `board-task`、`review` なら `board-reviewer` を直接立てる。`close` と `null` は今と同じく `board-worker` に渡す
- `board-task` は 1 手で計画のタスクを 1 つだけ倒す。タスクを倒し終えるまで、手ごとに新しい `board-task` が立つ
  （完了の通知を受けて監視役が待たずに次の手を渡すので、待ち時間は今と変わらない）
- `board-worker` はサブエージェントを立てない。`implement` で受け持つのは締めの段と archive 済みの段だけになる
- `status` の人向けの数行（`--json` を付けない形）の「次の一手」にも段が出る

変わらないこと:

- 1 周で渡す手は高々 1 つ。どのサブエージェントもまっさらな文脈で 1 手だけ進める
- 実装した作業者（`board-task`）とレビューする作業者（`board-reviewer`）は別のまま。レビューは 1 回だけ
- `next.action` の種類（`plan` / `revise-plan` / `implement` / `revise-impl` / `ready`）とステージの導出

### Impact

- コード:
  - `src/board/services/impl-step.ts`（新規）: 計画の本文から段を決める純関数
  - タスクの行の正規表現を `plan.repository.ts` と共有する（進捗バーと段の判定を食い違わせないため）
  - `src/board/repositories/`（新規）: カードのブランチの計画を `git show` で読むリポジトリ（`cli-runner.ts` 経由）
  - `src/board/cli/status-cli.ts` / `status-describe.ts` / `src/cli-main.ts`: `next.step` を足す
  - `src/board/services/next-action.ts`: `NextAction` に `step` を足し、`judgeImpling` の docstring を直す（判定は変えない）
- ループ: `.claude/skills/board-loop/SKILL.md`、`subagent-rules.md`、`.claude/agents/board-worker.md` / `board-task.md` / `board-reviewer.md`
- ドキュメント: `README.md`（AI ループの節）、`docs/architecture.md`（`status` の出力）、`CLAUDE.md`（読む場所の説明に差があれば）
- サーバ・API・画面・データ用ブランチの形: 変更なし

## 設計

### Decisions

#### 段は `status` が決め、`next.step` として監視役に渡す

段を決める方法は 3 つ考えた。

1. **`board-worker` が段を決めて、報告で返す。** 監視役はその報告を読んで次の周で `board-task` を立てる。
   タスクごとに段を決めるだけの `board-worker` が 1 つ挟まり、1 タスクあたりのトークンがほぼ倍になる。報告の文面から次の渡し先を読むことにもなる
2. **`board-task` / `board-reviewer` が自分で段を判定し、違えば止まる。** 監視役はどちらを立てるかを決められないので、結局 1 か 3 が要る
3. **`status` がカードのブランチの計画を読んで段を決める。** 監視役は今と同じく `status` の出力だけで渡し先を決められる

3 を採る。監視役の文脈に入るのは段の名前だけで、計画の中身は入らない。

`loop-impl-review` では、`status` にブランチの計画を `git show` で読ませる案を、次の 2 つの理由で採らなかった。

- サーバと `status` に git の読み取りを持ち込む
- 「計画ファイルがあれば列が立つ」という読み方と二重になる

今回は次のように範囲を絞り、2 つとも避ける。

- **読むのは `status` の CLI だけで、`next` に選ばれた 1 枚だけ。** サーバ（`GetBoardQuery`）とステージの導出（`stage-resolver.ts`）は触らない。
  画面とサーバの振る舞いは変わらない
- **段はステージではない。** 列はこれまでどおりメインのチェックアウトの計画ファイルと PR から導く。段は「実装中の中で次に誰を立てるか」だけに使う

#### 段を決める純関数

`resolveImplStep(plan)` を `src/board/services/impl-step.ts` に置く。入力は次のどちらかで、出力は `'task' | 'review' | 'close'`。

- `{ location: 'active', text }`: `plans/<id>.md` の本文
- `{ location: 'archived' }`: `plans/archive/<id>.md` だけがある

判定は `board-worker.md` の段の表と同じ順にする。

| 計画の状態                                | 段       |
| ----------------------------------------- | -------- |
| `plans/archive/` にある                   | `close`  |
| 未チェックのタスクがある                  | `task`   |
| 全部倒れていて、`## AI レビュー` 節が無い | `review` |
| 全部倒れていて、`## AI レビュー` 節がある | `close`  |

- archive 済みの段（`ai-board pr ready` のやり直し）も `board-worker` が受け持つので、`close` にまとめる。監視役の渡し先は同じだからである
- タスクの数え方は `subagent-rules.md` の「タスクの数え方と `## AI レビュー` 節」に従う。
  タスクの行の正規表現は `plan.repository.ts` の `TASK_PATTERN` / `COMPLETED_TASK_PATTERN` と同じものを使うよう、両方から import できる場所へ移す。
  コードブロックの中の行もタスクとして数える（進捗バーと同じ）
- `## AI レビュー` 節があるかは、コードブロック（` ``` ` で囲まれた範囲）の外の、行全体が `## AI レビュー` の見出しで決める
- 純関数なので、`src/board/services/__tests__/` に表の各行・コードブロックの中の見出し・`[X]` や詰めた書き方のテストを書く

#### ブランチの計画の読み方

`GitPlanReader`（仮の名前）を `src/board/repositories/` に置き、`CliRunner` で `git show <ref>:.ai-board/plans/<id>.md` を読む。
無ければ `git show <ref>:.ai-board/plans/archive/<id>.md` を試す。どちらも無ければ段は `null`。

- `<ref>` は、ローカルのブランチ `refs/heads/<branch>` があればそれ、無ければ `refs/remotes/origin/<branch>` にする。
  ループのサブエージェントはメインのチェックアウトと同じリポジトリのワークツリーでコミットし push するので、ローカルのブランチが最も新しい。
  クラウドの新しいセッションのようにローカルのブランチが無いときは、`origin` の追跡ブランチを読む
- `git` は `--root` のメインのチェックアウトで `-C` を付けて走らせる。引数は配列で渡し、shell を通さない（`CLAUDE.md` の不変条件）。
  カードの `branch` は誰でも書けるので、`refs/heads/` / `refs/remotes/origin/` を前に付けた完全な名前にして、`-` で始まる値がオプションとして読まれないようにする。
  `git check-ref-format --branch` を通らない名前なら、`git` を呼ばずに段を `null` にする
- 読めない（ブランチが無い、`git` が失敗した、カードの `branch` が null）ときは例外を投げず、段を `null` にする。
  `status` 全体は失敗させない（次の一手そのものは読めているため）
- `status` の手順で `git fetch` はしない。ネットワークに出るのは今と同じく PR の問い合わせだけにする。
  ローカルのブランチが無く、`origin` の追跡ブランチが古いときは、古い段が出うる（Risks を参照）

#### `NextAction` の形

`NextAction` に `step: ImplStep | null` を足す。`implement` 以外の手では常に `null`。
`pickNextAction` はこれまでどおり純関数のままで `step: null` を返し、`status-cli.ts` が `implement` のときだけ読み手に問い合わせて埋める。
`next.action` の種類は増やさない。`task` / `review` を手の種類にすると、`review-log.ts` / `card-cli.ts` / `dashboard-sections.ts` に手の種類が広がるうえ、
段は「`implement` の中の区切り」という `loop-impl-review` の語の使い方とも食い違うためである。

#### 監視役の渡し方

| `next.action` | `next.step`      | 渡す先           |
| ------------- | ---------------- | ---------------- |
| `plan` など   | —                | 今と同じ         |
| `implement`   | `task`           | `board-task`     |
| `implement`   | `review`         | `board-reviewer` |
| `implement`   | `close` / `null` | `board-worker`   |

- `prompt` はどの渡し先でも同じ 3 行（`cardId` / `action` / `MAIN`）のままにする。`step` は書かない。
  受けたサブエージェントは計画を自分で読み、自分の受け持つ段かを確かめる（下の「受けた側の確かめ」）
- `name` は `<subagent_type>-<cardId の先頭 45 文字>-<HHmm>` で、今と同じ規則に `board-task` / `board-reviewer` が加わるだけ
- `step` が `null` のとき `board-worker` に渡すのは、ワークツリーに入って計画を読めるのが `board-worker` だからである。
  `board-worker` が読んだ段がタスクを倒す段かレビューの段なら、手を付けずに `止まった` と報告する（下を参照）

#### 受けた側の確かめ

監視役はサブエージェントの結果を確かめない（今と同じ）。
これまで `board-worker` が入れ子の結果に対して行っていた確かめは、受けた側が自分で行い、満たせなければ `止まった` と報告する。

- **`board-task`:** 入力から `task` の行と `WT` を外し、`cardId` / `action` / `MAIN` を受ける。
  共通の決まりの「ワークツリーに入る」で自分でワークツリーに入り、上から最初の未チェックのタスクを自分で選ぶ（字下げされたサブタスクも 1 つと数える）。
  選んだ行と字下げを除いて同じ文の行がほかにあれば止まる（今の `board-worker` の確かめを移す）。
  コミットの前に、変えたチェックボックスが選んだ行だけであることを `git diff` で確かめる。push の後に `HEAD` と `origin/<branch>` の一致を確かめる
- **`board-reviewer`:** 入力から `WT` と `mr` を外し、`cardId` / `action` / `MAIN` を受ける。ワークツリーには自分で入り、`mr` はカードから読む（null なら止まる）。
  コミットが計画ファイルだけを変えることは、今もコミット前の `git status --porcelain` で確かめているので、それを残す
- **段の食い違い:** `status` の段は `git show` で読んだ時点のもので、受けた側がワークツリーで `git pull --ff-only` した後の計画と食い違うことがある。
  `board-task` は未チェックのタスクが無ければ、`board-reviewer` はタスクが残っているか `## AI レビュー` 節が既にあれば、何も変えずに `止まった` と報告する（今の前提の確かめと同じ）。
  `board-worker` は、読んだ段がタスクを倒す段かレビューの段なら、何も変えずに `止まった` と報告し、理由に段の食い違いを書く

`止まった` なので監視役は続けず、次の cron の周で `status` を読み直す。
食い違いがローカルのブランチの遅れによるものなら、受けたサブエージェントの `git pull` でローカルのブランチが進み、次の周の段は正しくなる。

#### `board-worker` からサブエージェントを立てる記述を外す

`board-worker.md` の「`board-task` / `board-reviewer` を立てて待つ」とその下のタスクを倒す段・レビューの段の節を消す。
`implement` の段の表は残し、タスクを倒す段とレビューの段の行は「監視役が `board-task` / `board-reviewer` に直接渡す。ここに来たら止まる」に変える。
報告の「AI レビュー」の項目から、レビューの段とタスクを倒す段の書き方を外す（その段は `board-reviewer` / `board-task` が報告する）。

`board-task` / `board-reviewer` の報告の形を、`board-planner` / `board-worker` と同じく先頭を `結果: 進めた / 保留して止まった / 止まった` にそろえる。
監視役の手順 4 はこの語で続けるかを決めるためである（`保留して止まった` は `board-task` / `board-reviewer` では使わない）。

#### 手順 0 から入れ子の前提を外す

`SKILL.md` の手順 0 は、動いているサブエージェントを `board-planner-` / `board-worker-` / `board-task-` / `board-reviewer-` の名前で見る、を残す。
4 つとも監視役が直接立てるものになるので、次の記述を消す。

- `board-task-` / `board-reviewer-` は `board-worker` の中から入れ子で立つ、という説明
- `board-worker` を止めても入れ子が残るおそれがあるので合わせて止めるよう書く、という指示

#### 手元とクラウドで同じ手順にする

入れ子が使える手元のセッションでも、入れ子をやめた手順で回す。
手順を 2 つ持つと、どちらの道を通ったかで確かめ方が変わり、サブエージェントの定義も二重になる。
入れ子をやめて失うのは、タスクごとの報告（5 行ほど）が監視役の文脈に積もらないことだけで、`loop-impl-review` の Risks で「入れ子が使えなければ諦めてよい」としたものである。

### Risks / Trade-offs

- **監視役の文脈にタスクの報告が積もる。** 1 タスク 1 手になるので、タスクの数だけ 5 行ほどの報告が監視役に届く。16 タスクで 80 行ほどで、`loop-impl-review` の見積もりと同じく圧迫はしない
- **段が古いことがある。** ローカルのブランチが無く `origin` の追跡ブランチが古い（人が別の場所から push した）と、古い段が出る。
  受けた側の前提の確かめで止まり、監視役は続けない。ループが同じ止まり方を繰り返すときは、人が `git fetch` するか、`board-worker` を手で渡す。
  `status` に `git fetch` を足す案は、`status` のたびにネットワークに出るので採らない
- **`status` に git の読み取りが入る。** CLI の `status` だけで、`next` の 1 枚だけに限る。サーバとステージの導出には入れない。
  それでも `status` が `git` の無い環境で走ると段が `null` になり、`board-worker` で止まる。ボードの CLI はリポジトリの中で使うものなので、実際には起きない見込み
- **結果の確かめが、書いた本人によるものになる。** これまで `board-worker` が外から確かめていた「選んだ行だけが `[x]` になった」「計画だけをコミットした」を、
  `board-task` / `board-reviewer` が自分で確かめる。次の手を受けるサブエージェントが、ワークツリーに未コミットの変更が無いことと、前提（未チェックのタスクの有無など）を確かめるので、壊れたまま先へは進みにくい。
  `board-reviewer` がコード（計画のほかのファイル）を直してコミットした場合は、締めの段の `board-worker` も気づかない。
  これは入れ子の前も、道具の制限で守れないものとして受け入れていたところで、人が PR の差分で見る
- **このカード自身は今の定義で進む。** サブエージェントの定義はメインのチェックアウトから読まれるので、このカードの実装は今の入れ子の手順で進む。
  クラウドのセッションで回すなら、このカードの実装中も同じ止まり方をする。その場合は手元のセッションで実装を進める

### Non-Goals

- 入れ子が使えるセッションで、今の入れ子の手順を残すこと（Decisions の「手元とクラウドで同じ手順にする」）
- サーバや画面に段を出すこと。`status` の CLI の `next` だけに載せる
- ステージの導出（`stage-resolver.ts`）に段やブランチの計画を持ち込むこと
- `revise-impl` の AI レビューを `board-reviewer` に分けること（`loop-impl-review` の Non-Goals のまま）
- 1 手で複数のタスクを倒すこと
- 止まったカードを監視役が飛ばして後ろのカードへ進むこと（`止まった` の扱いは今と同じ）

## 動作確認の手順

サブエージェントとスキルの定義はメインのチェックアウトから読まれるので、通しの流れはマージ後にしか確かめられない。

マージ前（CLI の `status`）:

1. ワークツリーで `npm run build` する
2. 共通の決まりの「動かして確かめるとき」に従い、スクラッチパッドに bare リポジトリとその clone を作り、`AI_BOARD_DATA` で指す。
   着手済みで plan 承認のある実装中のカードを 1 枚起こし、`branch` を試しのブランチ名にする（ローカルのリポジトリもスクラッチパッドに作る）
3. 試しのブランチの計画を次のように変えながら `AI_BOARD_DATA=<clone> node <WT>/dist/cli.js status --json --root <試しのリポジトリ>` を走らせ、`next.step` を見る。
   GitHub につながっていないと `next` が `null` になるので、つながる `config.yaml` で試すか、つながらなければこの手順は単体テストで代える
   - 未チェックのタスクがある → `task`
   - 全部倒れていて `## AI レビュー` 節が無い（コードブロックの中にだけある場合も含む） → `review`
   - 節がある → `close`
   - 計画が `plans/archive/` にだけある → `close`
   - カードの `branch` が存在しないブランチ → `null`（`status` は失敗しない）
4. `--json` を付けない `status` の「次の一手」に段が出る
5. `npm run typecheck && npm run lint && npm run format:check && npm test` が通る

マージ後（クラウドのセッション）:

6. スマホの Claude Code からクラウドのセッションを立て、実装中のカードがある状態で `/loop 5m /board-loop` を回し、次を見る
   - `implement` の手で、監視役が `board-task-` で始まるサブエージェントを直接立て、1 手で 1 タスクが倒れてコミットが PR に並ぶ
   - 完了の通知の後、cron を待たずに次の `board-task-` が立つ。動いている間の周は「作業中」とだけ出る
   - タスクを倒し終えると `board-reviewer-` が立ち、計画に `## AI レビュー` 節が足される
   - その後、`board-worker-` が立ち、動作確認を頼む（PR の本文に `## 見送った AI レビューの指摘` 節がある）
   - どのサブエージェントも `Agent` の道具が無いことで止まらない
7. 手元のセッションでも同じ順で進む（入れ子の `board-task` が立たない）

## タスク

### 1. 段を決める

- [x] タスクの行の正規表現（`TASK_PATTERN` / `COMPLETED_TASK_PATTERN`）を、`plan.repository.ts` と段の判定の両方から使える場所へ移す。振る舞いは変えない
- [x] `src/board/services/impl-step.ts` に `resolveImplStep` と `ImplStep` 型を足し、`src/board/services/__tests__/` に単体テストを書く（表の 4 行、コードブロックの中の `## AI レビュー`、`[X]` と詰めた書き方、タスクが 0 件の計画）
- [x] `src/board/repositories/` にカードのブランチの計画を `git show` で読むリポジトリを足す。ローカルのブランチ → `origin` の追跡ブランチの順、`plans/` → `plans/archive/` の順に読み、読めなければ null を返す。
      `check-ref-format` を通らないブランチ名では `git` を呼ばない。`CliRunner` の偽物でテストを書く

### 2. `status`

- [x] `NextAction` に `step` を足し（`pickNextAction` は `null` を返す）、`judgeImpling` と `NextActionKind` の docstring を、段は `status` が `next.step` で出す形に直す
- [x] `status-cli.ts` で、`next.action` が `implement` のときだけ読み手で計画を読み、`resolveImplStep` で `step` を埋める。依存は `StatusDependencies` に足し、`cli-main.ts` で組む。
      `status-cli.test.ts` に、`implement` で段が載ること、ほかの手では `null` のこと、読めないときに `null` で `status` が成功することのテストを足す
- [x] `status-describe.ts` の `describeNext` で、人向けの数行に段を出す。テストを足す

### 3. ループ

- [x] `.claude/agents/board-task.md` を、監視役から `cardId` / `action` / `MAIN` を受けて自分でワークツリーに入り、最初の未チェックのタスクを選ぶ形に直す。
      同じ文の行の確かめ、コミット前のチェックボックスの確かめ、push 後の `HEAD` の確かめ、未チェックのタスクが無いときの止まり、報告の先頭の `結果:` を書く。frontmatter の description も直す
- [x] `.claude/agents/board-reviewer.md` を、監視役から `cardId` / `action` / `MAIN` を受けて自分でワークツリーに入り、`mr` をカードから読む形に直す。報告の先頭の `結果:` をそろえ、frontmatter の description も直す
- [x] `.claude/agents/board-worker.md` から、サブエージェントを立てて待つ節とタスクを倒す段・レビューの段の節を消す。段の表のその 2 行を「ここに来たら止まる」に変え、報告の AI レビューの項目を直す。frontmatter の description も直す
- [x] `.claude/skills/board-loop/subagent-rules.md` の呼び名の表と「ワークツリーに入る」を、4 つのサブエージェントがどれも監視役から立ち、`board-task` / `board-reviewer` も自分でワークツリーに入る形に直す
- [x] `.claude/skills/board-loop/SKILL.md` の手の表と手順 3 に `next.step` による渡し先を足し、手順 0 から入れ子の記述を外す。手順 1 の絞り込みは `next` をそのまま出すので変えない。frontmatter の description も直す

### 4. ドキュメント

- [x] `README.md` の AI ループの節（段の表、作業中の判定）と、`docs/architecture.md` の `status` の出力に `next.step` を書く。`CLAUDE.md` に食い違う記述があれば直す

## AI レビュー

### 見送った指摘

- `src/board/services/impl-step.ts:23` の `CODE_FENCE_PATTERN` は ` ``` ` の囲みだけを見るので、`~~~` の囲みや 4 つのバッククォートの囲みの中の ` ``` ` で、コードブロックの内外の判定がずれる。計画の Decisions と共通の決まりがコードブロックを ` ``` ` で囲まれた範囲と定めており、それに沿っているので見送る
- `src/board/repositories/branch-plan.repository.ts:164` の `resolveRef` の `rev-parse --verify` は、`git show <ref>:<path>` が ref の無いときに失敗するので省ける（`git` の起動が 1 回の `find` で最大 6 回になる）。振る舞いを変えない整理なので見送る
- `src/board/repositories/branch-plan.repository.ts:112` の `PLANS_DIR` / `ARCHIVE_DIR` は、`src/shared/config.ts` と `plan.repository.ts` の同じ値を書き直している。振る舞いを変えない重複なので見送る
- `src/board/services/impl-step.ts:51` の `isOpenTask` は、`TASK_PATTERN` と `COMPLETED_TASK_PATTERN` の 2 つで判定しており、未チェックの行の正規表現 1 つを `plan-task.ts` に置けば済む。振る舞いを変えない整理なので見送る
- `.claude/skills/board-loop/subagent-rules.md:55` は `TASK_PATTERN` の在りかを `src/board/repositories/plan.repository.ts` と書いているが、この PR で `src/board/models/plan-task.ts` へ移った。`plan.repository.ts` の import からたどれ、数え方の決まりは変わらないので見送る
