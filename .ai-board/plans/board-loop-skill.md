# ボードを読んで、優先順に 1 つずつ作業を進めるループ

## 提案

### Why

人が「着手」を押しても、カードは 計画提案中 に移るだけで AI は動かない。
今は人がセッションを開くたびに、どのカードを進めるかを AI に指示している。
ボードには優先順（`rank`）と、AI が進めてよい列（計画提案中 / 実装中）が揃っているので、
次にやることはボードを読めば決まるはずである。
計画を `.ai-board/plans/archive/` へ移す作業も、これまではマージのあとに人が指示し、`archive-<id>` の別の PR で入れてきた
（#14 / #16 / #23）。ループでは、PR を Ready にする直前に同じ PR の中で移す。マージと同時に archive に入り、別の PR も人の追加のマージも要らない。

この手順を Claude Code のスキルに固め、`/loop 5m /board-loop` で間隔運転できるようにする（間隔はまず 5 分で回し、様子を見て変える）。
1 周で進めるのは 1 手だけにする。コミットと人の判断の単位を小さく保ち、止めたいときにすぐ止められるようにするためである。

### What Changes

- `ai-board status [--json]` を足す。サーバを起動せずに、ボードの状態（導出したステージ、判断待ち、次の一手）を標準出力に出す。
  退避した DB にあった `board-status-command` カードの内容を、このカードに取り込む
- 「次の一手」を決める純関数 `pickNextAction` を足す。優先順は 実装中 → 計画提案中、同じ列の中は `rank` の順
- スキル `.claude/skills/board-loop/SKILL.md` を足す。`status --json` の `next` どおりに 1 手だけ進め、★ の列には触らない
- 計画は、タスクを倒し終えて PR を Ready にする直前に、同じ PR の中で `plans/archive/` へ移す
- CLAUDE.md と README に `ai-board status` とループの運用を書く

### Impact

- 新規: `src/board/services/next-action.ts`、`src/board/cli/status-cli.ts`、各テスト、`.claude/skills/board-loop/SKILL.md`
- 変更: `src/board/composition.ts`、`src/cli-main.ts`、`CLAUDE.md`、`README.md`
- ステージの導出（`stage-resolver.ts`）と DB のスキーマには触らない

## 設計

### Decisions

#### 状態は `ai-board status` で読む

`ai-board card list` はステージを出さず、ステージを知る手段は今はサーバの `GET /api/board` だけである。
これに頼ると、ループを回すためにサーバを立て続けることになり、サーバが落ちればループも止まる。
ステージの導出は純関数で、DB と計画ファイルと PR の状態があれば済む。
そこで `getBoardQuery` を CLI から呼び、ロジックは足さない。

PR の状態の供給元の組み立ては `src/board/composition.ts` に `createMrStateSource` として置き、`startServer` と共有する。
`forge` があれば `createForgeClient` → `checkAuth` → `ForgePoller` を作る。サーバは `start()` し、`status` は `refresh()` を 1 回だけ待つ。
`gh` が使えなければ `unavailableMrStateProvider` にして、`forge` に理由を載せて続行する（ボードと同じ）。

出力は 2 種類。

- `--json`: `{ next, waiting, cards, forge, generatedAt }`。`cards` は `BoardCard` から `body` を除いたもの、
  `waiting` は判断待ちの区画のカードの ID と理由
- 引数なし: 人向けに 判断待ち / AI 作業中（「動きなし」の印付き）/ 次の一手 を数行で出す

区画への振り分けは `src/shared/dashboard-sections.ts` の `groupBySection` / `isStale` を再利用し、画面と食い違わせない。

#### 次の一手はコードで決める

「何をするか」をスキルの文章に書くと、周回ごとに解釈が揺れ、テストもできない。
判定は `src/board/services/next-action.ts` の純関数に置き、スキルは `next` に従うだけにする。

`pickNextAction(cards)` は `getBoardQuery` の `cards`（`rank` の実効値の順）を受け、中止のカードを除いて、次の 3 種のどれかか `null` を返す。
上の行ほど優先する。

| action        | 対象                                              | やること                                                     |
| ------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| `implement`   | 実装中                                            | 計画の次の未チェックのタスクを 1 つ倒す。全部倒れていれば AI レビュー → 計画を archive へ移す → `gh pr ready` |
| `plan`        | 計画提案中で、plan ゲートのエントリが無い         | 計画を書き、Draft の PR を出して提出する                     |
| `revise-plan` | 計画提案中で、最新エントリが 否決                 | 否決の理由を読み、同じブランチで計画を直して再提出する       |

否決の差し戻しに専用ルールは無く、否決されたカードは自然に 計画提案中 へ落ちる。
それを `latestReview.kind` で見分けるだけで、ステージの導出には触らない。

計画提案中で最新エントリが 提出 / 再提出 のカードは、提出したのに計画ファイルも Draft の PR も見えない状態である。
推測で作り直さず対象から外し、`waiting` に理由付きで出す。

#### 計画は Ready にする直前に、同じ PR の中で archive へ移す

これまでの archive の移動は、元の PR のマージのあとに `archive-<id>` のブランチから別の PR を出し、人がマージしてきた（OpenSpec の `changes/archive/` の名残）。
GitHub とつながっていれば、マージ済みのステージは PR の merged だけで立つので、archive は普段は重複している。
それでも archive をやめないのは、2 つの役割が残るからである。
1 つは、`config.yaml` に `github:` の無いリポジトリでは、archive が マージ済み を立てる唯一の手段であること。
もう 1 つは、GitHub の状態が引けないときの保険になること。
`gh` の失敗などで PR の状態が引けないと、archive されていない計画が main に残ったカードはルール 3（plan 承認済み）に当たり、
マージ済みなのに 実装中 に見える。ループにとってはこれが「実装を進める番のカード」に見えてしまう。

そこで、タスクを倒し終えて AI レビューを済ませたら、`git mv .ai-board/plans/<id>.md .ai-board/plans/archive/<id>.md` をコミットしてから `gh pr ready` する。
マージと同時に計画が archive に入るので、別の PR も人の追加のマージも要らない。
PR がマージされずに閉じられれば、archive の移動も main に入らない。

副作用として、そのブランチのワークツリーで動かしたボードでだけ、Ready にした時点でカードが マージ済み に見える。
メインのチェックアウトで動かすボードと `status` には影響しない。

archive のコミットのあと `gh pr ready` が失敗すると、次の周でもカードは 実装中 のまま `implement` が選ばれる。
スキルは計画を `plans/<id>.md` と `plans/archive/<id>.md` の両方から探し、archive 済みでタスクが全部倒れていれば `gh pr ready` だけをやり直す。

#### GitHub が引けないときはループを止める

archive は「マージされたカード」の取り違えは防ぐが、計画がまだブランチにしか無い段階のカードは守れない。
PR の状態が引けないと、Draft の PR で立っていた 計画レビュー も、Ready の PR で立っていた PR中 も、手前の AI の列へ落ちて見える。
`status --json` の `forge.status` が `connected` でなければ、スキルは何もせずに理由を報告して終わる。
`config.yaml` に `github:` が無い（`disabled` で理由が無い）リポジトリでは、PR の状態に頼らずに動くので続行する。

#### スキルは Plan モードを使わない

間隔運転では、Plan モードの承認待ちでループが止まってしまう。
計画の確認は Draft の PR と計画レビューのゲートで人が行うので、ループでは計画を直接ファイルに書く。
CLAUDE.md の「1 周の流れ」にある「AI が Plan モードで計画を立て」も、これに合わせて改める。

#### 作業はカードのブランチのワークツリーで行う

`status` をメインのチェックアウトで走らせると、ブランチにしか無い計画は見えない（`plan` が null になる）。
スキルはカードのブランチのワークツリー（`.claude/worktrees/<id>`）に入り、計画の中身とタスクはそこの `.ai-board/plans/<id>.md` から読む。
新しいブランチはカード ID と同じ名前で `origin/main` から切る。

### Risks / Trade-offs

- **`status` が PR 番号を書き戻す。** `ForgePoller.refresh` をそのまま使うので、`branch` から解決した `mr` がカードに書かれる。
  サーバと同じコード経路で、エージェントが番号を選んで書ける入口ではない。それでも、エージェントが叩く CLI から DB への書き込みが起きる。
  代案は (a) `refresh` に書き戻しを止めるオプションを足す、(b) 読み取り専用の 1 回取得を別に作る。この計画では今のまま書き戻す
- **`status` のたびに `gh api` を叩く。** PR の付いたカードの数だけ問い合わせが走る。5 分間隔でも、カードが数十枚なら GitHub の上限（1 時間 5,000 回）に届かない

### Non-Goals

- PR の指摘への対応（`pr-feedback-ai-turn` で決める。それまで PR中 には触らない）
- ループの稼働表示（`loop-activity`）
- 他リポジトリへのスキルの配布

## タスク

### 1. 次の一手

- [x] `src/board/services/next-action.ts` に `pickNextAction` と `NextAction`（`{ cardId, action, reason }`）を置く
- [x] `src/board/services/__tests__/next-action.test.ts`: 列の優先順、`rank` の順、中止の除外、否決からの `revise-plan`、
  提出済みで成果物の無いカードの除外、該当なしで `null`

### 2. `ai-board status`

- [x] `src/board/composition.ts` に `createMrStateSource` を置き、`startServer` もこれを使う（`src/board/__tests__/composition.test.ts`）
- [x] `src/board/cli/status-cli.ts` に `runStatusCli(argv, deps, io)` を置く（`card-cli.ts` と同じ形。`io` は `CardCliIo` を流用）。
  ステージの日本語名は `src/web/types.ts` から `src/shared/stage-labels.ts` へ移して共有する
- [x] `src/cli-main.ts` の `main` と `USAGE` に `status [--json] [--root <path>]` を足す
- [x] `src/board/cli/__tests__/status-cli.test.ts`: `:memory:` の DB と偽の `MrStateProvider` で、`--json` の形と人向けの出力を確かめる

### 3. スキル

- [x] `.claude/skills/board-loop/SKILL.md`（frontmatter: `name: board-loop`、`description`）に次の手順を書く
  - メインのチェックアウトで `npm run build` し、`node dist/cli.js status --json` を読む
  - `forge.status` が `connected` でなければ（`github:` の無いリポジトリを除く）、理由を報告して終わる（何も書かない）
  - `next` が `null` なら `waiting` を報告して終わる（何も書かない）
  - カードのブランチのワークツリーに入る（無ければ `git worktree add`）
  - `plan`: 計画を書く → コミット → push → `gh pr create --draft` → `card branch` → `card submit`
  - `revise-plan`: `card show` の否決の理由を読み、計画を直してコミット・push → `card submit --resubmit --reason <直した点>`
  - `implement`: 最初の未チェックのタスクを 1 つ倒す → 品質ゲート → チェックを付けてコミット・push。
    全部倒れていれば `/code-review` の指摘を直す → `git mv` で計画を `plans/archive/` へ移してコミット・push → `gh pr ready`。
    計画は `plans/` と `plans/archive/` の両方から探す（archive 済みなら `gh pr ready` だけをやり直す）
  - 最後に、何をしたかと、次に人が見るべきものを 3 行以内で報告する
- [x] ハードルールを書く: `startedAt` / `rank` / `skipGates` を書かない、承認 / 否決 / 中止を書かない、
  計画レビュー / PR中 のカードに触らない、品質ゲートを通らないままコミットしない、
  カード ID・ブランチ名・PR 番号を推測で作らない（見つからなければ止まって報告する）、1 周で 1 手だけ

### 4. ドキュメント

- [x] CLAUDE.md: `ai-board card` の一覧の近くに `ai-board status` を足す。「1 周の流れ」に `/loop 5m /board-loop` での間隔運転を足し、
  手順 2 の Plan モードの記述と、手順 4・5 の archive の移動（Ready にする直前に同じ PR の中で移す）を改める
- [x] README: CLI の一覧と運用の節に同じことを書く

### 5. 確かめる

- [ ] `npm run typecheck && npm run lint && npm run format:check && npm test`
- [ ] `npm run build` のあと `node dist/cli.js status` と `status --json` を実行し、ボードの画面（判断待ち / AI 作業中）と食い違わないこと
- [ ] サーバを止めた状態でも `status` が動くこと。`config.yaml` に `github:` の無い `--root` でも落ちないこと
- [ ] 着手済みのダミーのカードを 1 枚作り、`/board-loop` を手で 1 回呼んで、Draft の PR と `plan 提出` までで止まることを確かめる
- [ ] GitHub が引けない状態（`gh auth logout` 相当を偽の `ForgeClient` で再現）で、`status --json` の `forge.status` が `connected` でなく、スキルが止まる手順になっていること
- [ ] このカード自身も、Ready にする直前に計画を `plans/archive/` へ移す
