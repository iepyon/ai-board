# ループを本筋のセッション 1 つで回し、AI レビューだけをサブエージェントに切り分ける

## この計画で使う言葉

- **本筋のセッション**：人が会話している Claude Code のセッション、または `/loop 5m /board-loop` を回しているセッション。この計画で、計画と実装の手を自分で進める主体になる。
- **監視役 / 作業者**：今のループの分担。監視役（`board-loop` のスキル）が次の 1 手を選び、作業者（`board-planner` / `board-worker` / `board-reviewer` のサブエージェント）がその手を進める。この計画で、監視役と `board-planner` / `board-worker` の分担は無くなる。
- **手 / 段 / 節**：手は `ai-board status --json` の `next.action`（`plan` / `revise-plan` / `implement` / `revise-impl` / `ready`）。段は `implement` の中の区切り（`next.step` の `task` / `review` / `close`）。節は計画の `## タスク` を `### <番号>. <題>` で区切った範囲で、品質ゲートとコミットの単位。
- **1 手の記録**：データ用ブランチの `loop/` に置く、1 手の始まり・終わり・結果・トークン・時間の記録（`ai-board loop start` / `finish`）。

## 提案

### Why

ループを監視役とサブエージェントに分けた理由（ADR 0011）は、今のモデルではほとんど効いていない（カードの `## 背景`）。

- 監視役の文脈を膨らませない、自動の要約で前提が落ちても続けられる → 1M の文脈で、要約はほとんど入らない
- 人の判断を書く口から切り離す → frontmatter の hook はサブエージェントの中で発火せず（PR #74 で戻した）、それでも作業者は決まりを破らなかった

一方で、分けたことが原因の問題と決まりが積み重なっている。

- auto モードで、サブエージェントの commit・push・Ready が「人が頼んだ」ことの見えない操作として分類器に拒まれた（`loop-ready-permission`）
- 報告と完了の通知の順番、`loop start/finish` の照合、`ListAgents` での作業中の判定など、受け渡しのための決まり（ADR 0014）が手順書の多くを占める
- マージ済みのカードのかなりの数が、作業そのものではなくサブエージェントの繋ぎ込みのためだった

ただし「書いた者が自分の実装を審査しない」は、モデルの強さとは別の原則として残す。そこで、別の文脈に切り分けるのを AI レビューだけにする。

### What Changes

使う人から見た変化は次のとおり。

- `/board-loop`（「ボードを進めて」・間隔運転・`board-decide` の後の続き）を動かしたセッションが、`next` の手を **自分で** 進める。計画を書く・直す、節を倒す、締めの段、`revise-impl`、`ready` のどれもサブエージェントを立てない
- `implement` の手で `next.step` が `review` のときだけ、本筋のセッションが `board-reviewer` のサブエージェントを 1 つ立て、終わるのを待って次の手へ進む（案 A）。入れ子にならないので、クラウドでも今と同じく動く
- 手を終えたら同じ手番のまま `status` を読み直して次の手へ進む。`止まった` か `next` が null になるまで続く。カードが変わっても同じセッションのまま続け、`/clear` や新しいセッションは求めない（`## 探索メモ` 2）
- 1 手の記録は本筋のセッションが手の始まりと終わりに書く。時間は `loop finish` が開始から終了までの時間で埋めるので、どの手にも入る。トークンはレビューのサブエージェントの分が取れたときだけ入る
- `.claude/agents/board-planner.md` と `board-worker.md` は無くなる。中身は `board-loop` のスキルの隣のファイルに移る

変わらないこと:

- 次の一手は `ai-board status --json` の `next` / `next.step` が決める。1 度に 1 手。判定のコード（`pickNextAction` / `impl-step.ts`）、ステージの導出、サーバ、画面、データ用ブランチの形
- 人の判断（着手・承認・否決・中止・並び順・マージ・動作確認）は代行しない。カードに書けるのは `ai-board card` の CLI の提出 / 再提出 / 保留とブランチだけ
- 計画の書き方（節の切れ目は品質ゲートが通るところ）、節ごとの品質ゲートとコミット、AI レビューは 1 回だけでコードは直さない、締めの段・`revise-impl`・`ready` の中身
- `.claude/settings.json` の許可ルール

### Impact

- ループの手順書: `.claude/skills/board-loop/SKILL.md`（書き直す）、`.claude/skills/board-loop/subagent-rules.md`（`rules.md` に名前を変えて作業者向けの部分を削る）、
  `.claude/skills/board-loop/plan.md`・`implement.md`（新しく作る。`board-planner.md` / `board-worker.md` から移す）、
  `.claude/agents/board-planner.md`・`board-worker.md`（消す）、`.claude/agents/board-reviewer.md`、`.claude/skills/board-decide/SKILL.md`（手順 6）、`.claude/skills/board-dashboard/SKILL.md`
- コード: `src/board/repositories/loop-history.repository.ts`（`finish` の時間の既定）と、そのテスト。
  docstring と CLI の使い方の文: `src/shared/loop-step.ts`・`loop-activity.ts`・`board-log.ts`・`timeline.ts`、`src/board/services/impl-step.ts`・`next-action.ts`、
  `src/board/cli/loop-cli.ts`・`status-describe.ts`、`src/board/repositories/branch-plan.repository.ts`、`src/cli-main.ts`、`src/infrastructure/dist-check-cli.ts`、`src/web/components/detail/LoopSteps.tsx`
- ドキュメント: `CLAUDE.md`、`README.md`（AI ループ・ループの 1 手の記録・クラウド）、`docs/architecture.md`、`docs/specs/loop-activity/spec.md`、
  `docs/adr/0011`・`0014`（書き直す）、`0007`・`0008`・`0012`・`0013`（言葉を合わせる）、`docs/adr/README.md`

## 設計

### Decisions

#### 計画と実装の手は本筋のセッションが自分で進める

`board-loop` を動かしたセッションが、`next` を読んで、その手の手順を自分で行う。手ごとの手順は今の `board-planner.md` / `board-worker.md` の中身を移したファイルに置き、`SKILL.md` から手に応じて読ませる。

| `next.action` / `next.step`              | 読むファイル                       | 誰が進めるか                        |
| ---------------------------------------- | ---------------------------------- | ----------------------------------- |
| `plan` / `revise-plan`                   | `board-loop/plan.md`               | 本筋のセッション                    |
| `implement`（`task` / `close` / `null`） | `board-loop/implement.md`          | 本筋のセッション                    |
| `implement`（`review`）                  | `.claude/agents/board-reviewer.md` | `board-reviewer` のサブエージェント |
| `revise-impl` / `ready`                  | `board-loop/implement.md`          | 本筋のセッション                    |

移すときは、サブエージェントであるための部分だけを削り、手順の中身は変えない（縮めるのは `slim-worker` のカード）。削るのは次のもの。

- 「監視役の会話は見えない」「入力のプロンプトの 3 行」「受けた手が自分の役でなければ止まる」「報告は 5 行以内、ファイルの中身を含めない」
- `implement` の「レビューの段の前で止まり、次の起動に `board-reviewer` が立つ」は、「レビューの段に来たら `board-reviewer` を立てる（`SKILL.md` の手順）」に変える
- 「自動の要約が入ったら節の区切りで止まる」は、節の区切りで止まってよい、という形だけを残す（止まっても次の周が計画の `[x]` から続ける）

手の終わりに `結果:` の語（`進めた` / `保留して止まった` / `止まった`）を決める決まりは残す。`loop finish` の `--result` と、続けるかどうかの判定に使う。

`subagent-rules.md` は `rules.md` に名前を変え、本筋のセッションと `board-reviewer` の両方が読む共通の決まりにする。
「呼び名」の監視役と作業者の表、「まっさらな文脈」の説明、サブエージェントの中から別のサブエージェントを立てない、は削る。
カードの読み書き、ワークツリーに入る、タスクの数え方と節、指摘の分け方、保留の書き方、動かして確かめるとき、ハードルールは残す。

#### AI レビューは本筋のセッションが `board-reviewer` を 1 つだけ立てる（案 A）

`## 探索メモ` 1 のとおり。実装を書いたセッションが、自分の差分を自分でレビューしないための切り分けである。

- `next.step` が `review` のとき、本筋のセッションは `Agent` で `board-reviewer` を立てる。`prompt` は今と同じ `cardId` / `action` / `MAIN` の 3 行だけにし、要約を添えない（実装した側の前提を持ち込まないため）
- **前景で呼んで、終わるのを待つ。** バックグラウンドで立てないので、報告と完了の通知の順番の扱いや、`ListAgents` で作業中を確かめる手順は要らない
- `board-reviewer.md` は呼び出し元の言葉（監視役 → 本筋のセッション）と共通の決まりのファイル名だけを変える。指摘を計画の `## AI レビュー` 節に書くだけでコードを直さない、は変えない
- `subagent_type: "fork"` は使わない（会話を引き継ぐので切り分けにならない）

案 B（レビューを別のセッションで行う）は、人がセッションを立てる手間が増え、間隔運転とつながらないので採らない。

#### カードが変わっても同じセッションで続ける

`## 探索メモ` 2 のとおり。手を終えたら（`結果:` が `進めた` か `保留して止まった`）、同じ手番で `status` を読み直し、`next` が指す手へ進む。別のカードでも続ける。
止まるのは、`止まった`（同じ手がすぐまた選ばれて同じ止まり方を繰り返すため）、`next` が null、下の「ほかのループが触っている」のどれかのときである。

前のカードの文脈は持ち込まれうる。手順書には「カードの前提は、カード本文・計画・PR から読み直す。前のカードで決めたことを持ち込まない」を 1 行残す。

#### 同時に 2 つが同じカードに入らないようにする

本筋のセッションは手を手番の中で同期で進めるので、同じセッションの中では重ならない。
間隔運転の周（`/loop`）は手番が終わるまで待って届くので、手の途中には割り込まない。

重なりうるのは、別のセッション（別の端末のループやルーティン）が同じカードを触っているときだけである。
`ListAgents` の確かめの代わりに、`board-decide` の手順 6 と同じく、`status --json --only next,waiting,forge,loop` の `loop.running` に
別のループ（`loop` が自分のセッション ID でない）の `next.cardId` への終わっていない記録があれば、その周は止まってどのループかを伝える。

#### 1 手の記録は本筋のセッションが書き、時間は CLI が埋める

`## 探索メモ` 3 のとおり。記録の単位は今と同じ「1 手」で、`ai-board loop start` を手の始まりに、`finish` を手の終わりに本筋のセッションが書く。

- `--agent`：本筋のセッションが進める手では渡さない（`null`。画面と表では「—」）。レビューの段では `board-reviewer-<カード ID の先頭 45 文字>-<HHmm>` を渡す
- **時間：** `loop finish` で `--duration-ms` が無ければ、記録の `startedAt` から `finishedAt` までのミリ秒で `durationMs` を埋める（`loop-history.repository.ts` の `finish`）。
  本筋のセッションは時間を自分で測らない。`--duration-ms` を渡したときはその値を使う（今と同じ）。`interrupted` で閉じた記録は今どおり `null`
- **トークン：** レビューの段で、`Agent` の結果に使ったトークンが載っていれば `--tokens` に写す。本筋のセッションが進めた手では省く（取れないため）
- `--result` の対応表（`進めた` → `advanced` など）は変えない。`failed` は `board-reviewer` の `Agent` の呼び出しが失敗したときに使う
- `loop start` / `finish` が失敗しても手は止めない（今と同じ）。報告と完了の通知の照合（ADR 0014 の「書く前の確かめ」）は、手を同期で進めるので要らなくなる

時間を CLI で埋めるのは、`finish` の時点で開始の時刻を持っているのが CLI だからである。本筋のセッションに `date` の差を計算させると、書き方がずれるか省かれる。
メトリクスとチャートの改良は `harness-metrics`・`bottleneck-chart` のカードで行う。ここでは記録の形（`ai-board-data.yaml` の版、JSON の項目）を変えない。

#### `board-decide` の後の続き

ADR 0013 の続け方（AI の番を作る判断の後に 1 周を続ける）は残す。続けた周は、渡すのではなく本筋のセッションが自分で進める。
手順 6 の否決のときの問い「続けて作業者に渡す / 待つ」を「続けて直す / 待つ」に言い換え、`board-loop` の手順を読んで 1 周を走らせる、の形にする。
「別のループの終わっていない記録」の確かめは今のまま残す。

#### ADR

- **0011** を「ループは本筋のセッションが `next` の手を自分で進め、AI レビューだけをサブエージェントに切り分ける」に書き直す。
  退けた案に、監視役と 3 役のサブエージェント（今の形）と、案 B を置く
- **0014** を「1 手の記録は本筋のセッションが手の始まりと終わりに書き、時間は `finish` が埋める」に書き直す。
  報告と完了の通知の順番の問題は、前景で同期に進めることで無くなった、を背景に書く
- **0007・0008・0012・0013** は、監視役・作業者・サブエージェントの言葉を今の形に合わせる。判断そのものは変えない
- `CLAUDE.md` の「サブエージェント（`board-*`）の中からは `PreToolUse` の hook が拒む」は、hook が PR #74 で外れて今は無いので、手順書の決まりで守る、に直す

### Risks / Trade-offs

- **前のカードの前提が次のカードに紛れ込む。** 人がそれを受け入れた（`## 探索メモ` 2）。手順書の 1 行と、計画レビュー・AI レビュー・動作確認で拾う
- **1 つのセッションの文脈が長く伸びる。** 間隔運転で何枚も続けると、いずれ自動の要約が入る。節ごとのコミットと計画の `[x]` から続きを読めるので、要約の後も続けられる
- **書いた者と審査する者の分離が、レビューの段だけになる。** 計画を書いたセッションが同じ文脈で実装する。計画は人が計画レビューで読み、差分は `board-reviewer` と人が見る
- **トークンの記録がほとんど空になる。** 本筋のセッションの手では取れない。時間は全部の手に入るので、手ごとの重さは時間で比べる
- **`durationMs` の意味が変わる。** 今は「サブエージェントが動いていた時間」、これからは「手の始まりから終わりまで」（記録を書く時間も含む）。数秒の差で、比べるには足りる
- **人の判断の口を技術的には止めていない。** 今も hook は無く手順書の決まりで守っている。本筋のセッションは `board-decide` を持てるセッションなので、「周の中で人の判断を自分から書かない」をハードルールに残す
- **auto モードの分類器の止まり（`loop-ready-permission`）が直るかは確かめていない。** 本筋のセッションの操作になるので起きにくくなる見込みだが、このカードでは閉じない

### Non-Goals

- 研修の資料（「文脈の切り分け」の題材の整理）。`training-seed` で行う（`## 探索メモ` 5）
- 手順書の中身を縮める（`slim-worker`・`slim-decide`）。ここでは場所を移し、サブエージェントであるための部分だけを削る
- `board-reviewer` で `/code-review` を使えるようにする（`reviewer-code-review`）
- メトリクスとチャートの改良、1 手の記録の形を変える（`harness-metrics`・`bottleneck-chart`）
- `loop-ready-permission` を閉じる。`.claude/settings.json` の許可ルールを変える
- `next` / `next.step` の判定、ステージの導出、画面、データ用ブランチの形

## 動作確認の手順

ワークツリーは `$MAIN/.claude/worktrees/loop-single-session`（以下 `$WT`）。先に `cd "$WT" && npm ci && npm run build`。

1. `loop finish` が時間を埋める（試しのデータで）
   ```bash
   S=$(mktemp -d); git init --bare "$S/origin.git"; git clone "$S/origin.git" "$S/data"
   export AI_BOARD_DATA="$S/data"
   node "$WT/dist/cli.js" init
   printf '## アイデア\n\nためし\n' | node "$WT/dist/cli.js" card create --title ためし --id try-card
   ```
   - `node "$WT/dist/cli.js" loop start --loop t1 --card try-card --action plan` → 数秒待つ → `node "$WT/dist/cli.js" loop finish --loop t1 --card try-card --result advanced`（`--duration-ms` を渡さない）
   - 続けて同じく `start` し、`finish` に `--duration-ms 1234` を渡す
   - 期待: `cat "$S/data/loop/"*.json` で、1 件目の `durationMs` が待った秒数ぶん（数千）、2 件目が `1234` になっている
   - 終わったら `unset AI_BOARD_DATA`
2. 本筋のセッションで回る（本物のボードで）
   - 計画提案中か実装中のカードがあるときに、新しい会話で「`$WT/.claude/skills/board-loop/SKILL.md` の手順でボードを進めて」と頼む
   - 期待: 計画の手と実装のタスクの段では `Agent` が呼ばれず、会話の中で計画を書く・節を倒す・コミットする様子が見える。
     レビューの段に来たときだけ `board-reviewer` が 1 つ立ち、終わった後に同じ手番で締めの段へ進んで動作確認を頼む。
     `止まった` か `next` が null になるまで、人が何も打たなくても続く。次の一手が別のカードを指しても、同じ会話のまま続く
3. 記録が残る
   - 2 の後に「ボードを見せて」と頼み、ダッシュボードの「ログ」のループの手に、2 で進めた手が並び、どの手にも時間が入っていること。
     作業者の欄は、レビューの段だけ `board-reviewer-…` で、ほかは「—」
4. 消えたものを見る
   - `ls "$WT/.claude/agents"` が `board-reviewer.md` だけであること
   - `grep -rn "board-planner\|board-worker\|subagent-rules\|ListAgents" "$WT" --include=*.md --include=*.ts --exclude-dir=node_modules --exclude-dir=archive` が、計画ファイルとテストの記録の例（`agent: 'board-worker-…'` など）以外に出ないこと

## タスク

### 1. `loop finish` が時間を埋める

- [x] `src/board/repositories/loop-history.repository.ts` の `finish` で、`input.durationMs` が `null` なら `startedAt` から `finishedAt` までのミリ秒（0 未満なら 0）で埋める
- [x] `src/board/repositories/__tests__/loop-history.repository.test.ts` と `src/board/cli/__tests__/loop-cli.test.ts` に、`--duration-ms` を省いたときに埋まること、渡したときはその値になることのテストを足す（今の「省いたら null」を確かめるテストがあれば直す）
- [x] `src/shared/loop-step.ts` の docstring（1 手の記録の説明、`agent` / `tokens` / `durationMs` / `failed` の意味）と `loop-cli.ts` の使い方の文を、本筋のセッションが手の始まりと終わりに書く形に直す

### 2. 手順書を本筋のセッションの形に移す

- [x] `.claude/skills/board-loop/subagent-rules.md` を `git mv` で `rules.md` にし、作業者向けの部分（呼び名の監視役と作業者の表、まっさらな文脈、入れ子にしない）を削る。残す節の見出しは変えない
- [x] `.claude/agents/board-planner.md` の手順を `.claude/skills/board-loop/plan.md` に移し、サブエージェントであるための部分（入力の 3 行、役違いで止まる、報告の 5 行）を削る。`board-planner.md` を消す
- [x] `.claude/agents/board-worker.md` の手順を `.claude/skills/board-loop/implement.md` に移し、同じく削る。レビューの段では止まらず `SKILL.md` の手順で `board-reviewer` を立てる、に変える。`board-worker.md` を消す
- [x] `.claude/skills/board-loop/SKILL.md` を書き直す: ボードを読む → 止まる条件（`status` の失敗、`next` が null、別のループが `next.cardId` を触っている）→ `loop start` → 手に応じて `plan.md` / `implement.md` で自分で進めるか、`board-reviewer` を前景で立てる → `loop finish` → 3 行以内で伝える → 続けるか決める。
      `ListAgents`・バックグラウンド・報告と完了の通知の扱いを消す。ハードルール（人の判断を周の中で書かない、`fork` を使わない、`waiting` のカードに触らない など）は残す。`description` も合わせる
- [x] `.claude/agents/board-reviewer.md` の呼び出し元の言葉と共通の決まりのファイル名（`rules.md`）を直す。`description` も合わせる
- [x] `.claude/skills/board-decide/SKILL.md` の手順 6 を、本筋のセッションが `board-loop` の手順で 1 周を進める形に直す（「続けて作業者に渡す」→「続けて直す」）
- [x] `.claude/skills/board-dashboard/SKILL.md` のサブエージェントへの言及を、レビューのサブエージェントの `prompt` に混ぜない、の形に直す

### 3. ドキュメントと ADR

- [x] `docs/adr/0011-loop-roles.md` と `docs/adr/0014-continue-loop-on-handback.md` を、Decisions の「ADR」のとおり書き直す（ファイル名も今の判断に合わせて `git mv` してよい）。`docs/adr/README.md` の表を合わせる
- [x] `docs/adr/0007`・`0008`・`0012`・`0013` の、監視役・作業者・サブエージェントの言葉を今の形に合わせる
- [x] `README.md` の「AI ループ」「ループの 1 手の記録」「クラウドのセッションで回す」と、`docs/architecture.md` の「ループの 1 手の記録」と段の渡し先、`docs/specs/loop-activity/spec.md` を直す
- [x] `CLAUDE.md` の「読む場所」のループの手順書、書き込み境界の表の「ループの監視役」の行、hook の段落を直す
- [x] `src/` の docstring と画面の注記（`loop-activity.ts`・`board-log.ts`・`timeline.ts`・`impl-step.ts`・`next-action.ts`・`status-describe.ts`・`branch-plan.repository.ts`・`cli-main.ts`・`dist-check-cli.ts`・`LoopSteps.tsx`）の監視役・サブエージェント・`board-worker` への言及を直す。判定と表示の振る舞いは変えない

## AI レビュー

- [x] `.claude/skills/board-loop/SKILL.md:108` の `board-reviewer` の `name` は `board-reviewer-`（15 文字）＋カード ID の先頭 45 文字＋`-`＋`HHmm`（4 文字）で最大 65 文字になり、次の行の「名前は 64 文字まで」を超える。45 は消えた `board-worker-`（13 文字）に合わせた値で、カード ID が 44 文字以上だとレビューの段の `Agent` の呼び出しが失敗し、そのカードで毎周止まる。切り詰めを 43 文字にし、3.1 の `--agent` の説明など同じ式を書いた箇所（`README.md`・`docs/architecture.md`・ADR 0014 にあれば）も合わせる（計画の Decisions の「45 文字」も同じ数え違い）
- [x] `.claude/skills/board-loop/implement.md:40` の段の表で、レビューの段の行の「すること」が「`SKILL.md` の手順で `board-reviewer` を立てる。この手順書では何もしない」になっており、同じ節の箇条（52 行目）とハードルール（265 行目）の「コードにも計画にも触らず `止まった` で手を終える」と食い違う。表だけを読むと `結果:` の語を決めずに戻り、`loop finish` が `unknown` になるか、手順書の中から `board-reviewer` を立てうる。表の行を「何も変えずに `止まった` で手を終える（段の食い違い。`board-reviewer` を立てるのは `SKILL.md` だけ）」に直す

### 見送った指摘

- `.claude/skills/board-loop/implement.md:52` で、`git pull` の後にレビューの段だと分かると `止まった` で手を終え、`SKILL.md` の手順 5 は続けないので、正しい段は次の周（間隔運転か人の「ボードを進めて」）まで選ばれない。本筋のセッションが自分で push するので `status` と計画が食い違うことは稀で、止まった後に次の周を待つのは前の監視役の形と同じなので見送る
- `.claude/skills/board-loop/SKILL.md:182` で、周を回すセッションが `board-decide` も持ち、周の中で人の判断を書かないことを手順書の決まりだけで守っている。計画の Risks「人の判断の口を技術的には止めていない」で受け入れた形なので見送る
- `.claude/skills/board-loop/SKILL.md:154` の手順 5 は、カードが変わっても回数の上限なく同じセッションで続けるので、前のカードの前提が紛れ込む余地が残る。`## 探索メモ` 2 で人が決めた形で、計画の Risks にも書かれているので見送る
- `src/board/repositories/loop-history.repository.ts:339` の時間の既定は開始から終了までの壁時計の時間なので、手の途中の許可の確認や人への問いで待った時間も `durationMs` に入る。計画の Risks「`durationMs` の意味が変わる」で受け入れており、メトリクスの改良は `harness-metrics` の範囲なので見送る
- `.claude/skills/board-loop/SKILL.md:143` のとおり、トークンはレビューの段でしか残らず、振り返りの手ごとのトークンの集計は一部の手だけになる。計画の Decisions と Non-Goals（メトリクスとチャートの改良は `harness-metrics`・`bottleneck-chart`）のとおりなので見送る

### 人に判断してほしいこと

- `.claude/skills/board-loop/rules.md:20` と `implement.md:8` は「実装を書いた本筋のセッションは、自分の差分を AI レビューしない」と書くが、`implement.md:214` の `revise-impl` では同じ本筋のセッションが直した差分に自分で `/code-review` をかける。前は `revise-impl` もまっさらな `board-worker` が直してレビューしていたが、今は元の実装を書いた文脈のまま審査する。決まりの文を「`implement` のレビューの段だけを切り分ける」に狭めるか、`revise-impl` のレビューも `board-reviewer` に切り分けるか（`next.step` の判定や `board-reviewer` の前提の確かめに手が入る）は人が決める
