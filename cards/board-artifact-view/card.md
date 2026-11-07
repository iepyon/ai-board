---
id: board-artifact-view
title: ユーザは、アイデアの一覧・AI 作業中・判断待ちを、Artifact のボード 1 枚で一目で見たい
created: '2026-11-06T08:43:09.496Z'
skipGates: []
branch: null
pr: null
---

## アイデア

「ボードを見せて」と頼むと、アイデアの一覧・AI 作業中・判断待ちの 3 つの区画を並べたボードを、Artifact の 1 枚のページで出す。

- **中身は `status --json` をそのまま使う。** 判断待ちは `waiting`（出せる判断つき）、AI 作業中は `working`、アイデアの一覧は `ideas`（rank の順、区切り線つき。中止したカードは入らない）、ループの様子は `loop`（`running` / `lastFinishedAt`）を描く。ページの側でステージや区画を導出しない
- **見渡すことだけに絞る。** グラフ・集計・ログ・更新ボタンは付けない。新しくしたいときはチャットで頼み直す（ループの手のたびに出し直すのは `board-artifact-loop-republish`）
- **判断はページから書かない。** 判断待ちのカードには出せる判断を並べるだけにし、書くのは今までどおりチャットの `board-decide` で行う

## 背景

ADR 0017 で画面・サーバ・`status --html` のダッシュボードを外し、ボードを見る入口は `ai-board status` だけになった。
人向けの数行（`status-cli.ts`）には、GitHub の接続・ループの最後の手・判断待ち・AI 作業中・次の一手は出るが、アイデアの一覧は出ない。
どのアイデアが次に来るかは `status --json --only ideas` を読まないと分からない（2026-11-07 にアイデアを整理したときも、チャットで JSON から一覧を組み立てた）。
ボードはスマホから Claude Code のクラウドのセッションで回すことが多く、ターミナルの数行よりも、3 つの区画を一目で見渡せるページで見たい。

## 論点

- **HTML をどこで組むか。** 本体（`status` の出力）で組むなら、ADR 0017 の「`status --html` を外す」を書き直す。スキルが `status --json` を読んで組むなら、見た目が毎回ぶれないようにテンプレートの置き方を決める。今あるスキルは `adr` / `board-decide` / `board-loop` の 3 つで、ボードを見せるスキルは無い
- **ADR の扱い。** ADR 0017 は `board-dashboard` のスキルを消すと決めている。今回の形を ADR 0017 の改訂にするか、新しい ADR にするか
- **人向けの `status` にアイデアを足すだけで足りないか。** ページを作らずに、人向けの数行にアイデアの一覧（区切り線より上だけ、など）を足す案と比べる
- **GitHub に繋がらないとき。** `status` は 1 回の実行で `refresh()` を 1 回だけ行い、届かなければマージ済みの控えで描く（`forge` の項目に接続の状態が出る）。ページにも接続の状態を出すか

## 探索メモ

- 2026-11-07 にリポジトリの今の形に合わせて本文を書き直した
- 外す前の形は、コミット 981587f の親にある（`src/board/cli/status-html.ts`、`.claude/skills/board-dashboard/SKILL.md`、消した ADR 0015）。更新ボタンの仕組みは `board-artifact-dashboard`（PR #71）。更新ボタンはページからコネクタを読み込めず動かなかった（2026-11-06、`drop-refresh-button` の背景）ので、今回は持たせない
- `status --json` の項目は `next` / `waiting` / `working` / `cards` / `ideas` / `forge` / `loop` / `generatedAt`。`--only` で絞れる
