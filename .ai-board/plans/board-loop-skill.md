# ボードを読んで、優先順に 1 つずつ作業を進めるループ

## 提案

### Why

人が「着手」を押しても、カードは 計画提案中 に移るだけで AI は動かない。
今は人がセッションを開くたびに、どのカードを進めるかを AI に指示している。
ボードには優先順（`rank`）と、AI が進めてよい列（計画提案中 / 実装中）が揃っているので、
次にやることはボードを読めば決まるはずである。

この手順を Claude Code のスキルに固め、`/loop 15m /board-loop` で間隔運転できるようにする。
1 周で進めるのは 1 手だけにする。コミットと人の判断の単位を小さく保ち、止めたいときにすぐ止められるようにするためである。

### What Changes

- `ai-board status [--json]` を足す。サーバを起動せずに、ボードの状態（導出したステージ、判断待ち、次の一手）を標準出力に出す。
  退避した DB にあった `board-status-command` カードの内容を、このカードに取り込む
- 「次の一手」を決める純関数 `pickNextAction` を足す。優先順は 実装中 → 計画提案中、同じ列の中は `rank` の順
- スキル `.claude/skills/board-loop/SKILL.md` を足す。`status --json` の `next` どおりに 1 手だけ進め、★ の列には触らない
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

依存の組み立ては `src/board/composition.ts` に `createStatusDependencies(config, db)` として置き、`startServer` と同じ構成を共有する。
`forge` があれば `createForgeClient` → `checkAuth` → `ForgePoller` を作り、`start()` はせずに `refresh()` を 1 回だけ待つ。
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

| action        | 対象                                              | やること                                                     |
| ------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| `implement`   | 実装中                                            | 計画の次の未チェックのタスクを 1 つ倒す。全部倒れていれば AI レビューのうえ `gh pr ready` |
| `plan`        | 計画提案中で、plan ゲートのエントリが無い         | 計画を書き、Draft の PR を出して提出する                     |
| `revise-plan` | 計画提案中で、最新エントリが 否決                 | 否決の理由を読み、同じブランチで計画を直して再提出する       |

否決の差し戻しに専用ルールは無く、否決されたカードは自然に 計画提案中 へ落ちる。
それを `latestReview.kind` で見分けるだけで、ステージの導出には触らない。

計画提案中で最新エントリが 提出 / 再提出 のカードは、提出したのに計画ファイルも Draft の PR も見えない状態である。
推測で作り直さず対象から外し、`waiting` に理由付きで出す。

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
- **`status` のたびに `gh api` を叩く。** PR の付いたカードの数だけ問い合わせが走る。15 分間隔のループなら問題にならない

### Non-Goals

- PR の指摘への対応（`pr-feedback-ai-turn` で決める。それまで PR中 には触らない）
- ループの稼働表示（`loop-activity`）
- 他リポジトリへのスキルの配布

## タスク

### 1. 次の一手

- [ ] `src/board/services/next-action.ts` に `pickNextAction` と `NextAction`（`{ cardId, action, reason }`）を置く
- [ ] `src/board/services/__tests__/next-action.test.ts`: 列の優先順、`rank` の順、中止の除外、否決からの `revise-plan`、
  提出済みで成果物の無いカードの除外、該当なしで `null`

### 2. `ai-board status`

- [ ] `src/board/composition.ts` に `createStatusDependencies(config, db)` を置く
- [ ] `src/board/cli/status-cli.ts` に `runStatusCli(argv, deps, io)` を置く（`card-cli.ts` と同じ形。`io` は `CardCliIo` を流用）
- [ ] `src/cli-main.ts` の `main` と `USAGE` に `status [--json] [--root <path>]` を足す
- [ ] `src/board/cli/__tests__/status-cli.test.ts`: `:memory:` の DB と偽の `MrStateProvider` で、`--json` の形と人向けの出力を確かめる

### 3. スキル

- [ ] `.claude/skills/board-loop/SKILL.md`（frontmatter: `name: board-loop`、`description`）に次の手順を書く
  - メインのチェックアウトで `npm run build` し、`node dist/cli.js status --json` を読む
  - `next` が `null` なら `waiting` を報告して終わる（何も書かない）
  - カードのブランチのワークツリーに入る（無ければ `git worktree add`）
  - `plan`: 計画を書く → コミット → push → `gh pr create --draft` → `card branch` → `card submit`
  - `revise-plan`: `card show` の否決の理由を読み、計画を直してコミット・push → `card submit --resubmit --reason <直した点>`
  - `implement`: 最初の未チェックのタスクを 1 つ倒す → 品質ゲート → チェックを付けてコミット・push。
    全部倒れていれば `/code-review` の指摘を直してから `gh pr ready`
  - 最後に、何をしたかと、次に人が見るべきものを 3 行以内で報告する
- [ ] ハードルールを書く: `startedAt` / `rank` / `skipGates` を書かない、承認 / 否決 / 中止を書かない、
  計画レビュー / PR中 のカードに触らない、品質ゲートを通らないままコミットしない、
  カード ID・ブランチ名・PR 番号を推測で作らない（見つからなければ止まって報告する）、1 周で 1 手だけ

### 4. ドキュメント

- [ ] CLAUDE.md: `ai-board card` の一覧の近くに `ai-board status` を足す。「1 周の流れ」に `/loop 15m /board-loop` での間隔運転を足し、
  手順 2 の Plan モードの記述を改める
- [ ] README: CLI の一覧と運用の節に同じことを書く

### 5. 確かめる

- [ ] `npm run typecheck && npm run lint && npm run format:check && npm test`
- [ ] `npm run build` のあと `node dist/cli.js status` と `status --json` を実行し、ボードの画面（判断待ち / AI 作業中）と食い違わないこと
- [ ] サーバを止めた状態でも `status` が動くこと。`config.yaml` に `github:` の無い `--root` でも落ちないこと
- [ ] 着手済みのダミーのカードを 1 枚作り、`/board-loop` を手で 1 回呼んで、Draft の PR と `plan 提出` までで止まることを確かめる
