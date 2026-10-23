---
name: board-loop
description: ai-board のボードを読み、AI が進めてよいカード（計画提案中 / 実装中）を優先順に 1 手だけ進める。計画を書いて Draft の PR を出す、否決された計画を直す、計画のタスクを 1 つ倒す、倒し終えたら Ready にする、のどれか 1 つ。`/loop 5m /board-loop` で間隔運転する。「ボードを進めて」「次のカードをやって」「board-loop」で使う。
---

# board-loop — ボードを 1 手だけ進める

1 回の呼び出しで行うのは **1 手だけ**。何をするかは自分で選ばず、`ai-board status --json` の `next` に従う。
人の判断（着手・承認・否決・中止・並び順・マージ）は代行しない。

## 0. ボードを読む

メインのチェックアウト（以下 `$MAIN`）で `status` を読む。`dist/` が古ければ先にビルドする。

```bash
MAIN=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
if [ ! -f "$MAIN/dist/cli.js" ] || [ "$(git -C "$MAIN" log -1 --format=%ct)" -gt "$(stat -f %m "$MAIN/dist/cli.js" 2>/dev/null || stat -c %Y "$MAIN/dist/cli.js")" ]; then
  npm --prefix "$MAIN" run build
fi
node "$MAIN/dist/cli.js" status --json --root "$MAIN"
```

カードの読み書きは `node "$MAIN/dist/cli.js" card ...` で行う（以下 `ai-board card ...` と書く）。DB を直接触らない。

## 1. 止まる条件（何も書かずに報告して終わる）

- `status` が失敗した。「不明なオプションです: status」なら、`$MAIN` のコードが `ai-board status` を持たない古いものである。
  `$MAIN` を `origin/main` に更新してビルドし直すよう人に頼む（自分では更新しない）
- `forge.status` が `connected` でない。ただし `{ "status": "disabled", "reason": null }`（`config.yaml` に `github:` が無い）なら続ける。
  PR の状態が引けないと、計画レビュー / PR中 のカードが手前の AI の列に落ちて見え、取り違えるため
- `next` が `null`。`waiting` のカードを人に知らせて終わる

## 2. カードのワークツリーに入る

`ai-board card show <next.cardId>` で本文と `branch` / `mr` を読む。作業は必ずカードのブランチのワークツリーで行い、`$MAIN` では作業しない。

- **`plan` で `branch` が null:** カード ID と同じ名前のブランチを `origin/main` から切る。
  ```bash
  git -C "$MAIN" fetch origin
  git -C "$MAIN" worktree add -b <id> "$MAIN/.claude/worktrees/<id>" origin/main
  ```
  同じ名前のブランチが既にローカルかリモートにあれば、作らずに止まって報告する
- **それ以外:** `branch` のワークツリーを使う（`git worktree list` で探し、無ければ `git worktree add "$MAIN/.claude/worktrees/<id>" <branch>`）。
  `branch` が null なら止まって報告する。入ったら `git pull --ff-only`
- `node_modules` が無ければ `npm ci`
- ワークツリーに未コミットの変更が残っていたら、前の周が途中で止まっている。手を付けずに止まって報告する

## 3. `next.action` ごとの 1 手

### `plan` — 計画を書いて提出する

1. カード本文（アイデア / 背景 / 論点）と関係するコードを読む
2. `.ai-board/plans/<id>.md` に計画を書く。Plan モードのツールは使わない（間隔運転では承認待ちで止まる。人の確認は Draft の PR で行う）。
   構成は `.ai-board/plans/archive/` の計画にならう: `# 題` / `## 提案`（Why / What Changes / Impact）/ `## 設計`（Decisions / Risks / Trade-offs / Non-Goals）/ `## タスク`（`- [ ]` のチェックボックス）。日本語で書く
3. コミット（`docs: 〜の計画を立てる`）→ `git push -u origin <branch>` → `gh pr create --draft`（本文に計画ファイルの場所、概要、判断してほしい点）
4. `ai-board card branch <id> <branch>` → `ai-board card submit <id> --reason "<判断してほしい点>"`

### `revise-plan` — 否決された計画を直して再提出する

1. `ai-board card show <id>` の `## レビュー` の最新の 否決 の理由と、`gh pr view <mr> --comments` を読む
2. 計画を直してコミット（`docs: 〜の計画を直す`）→ push
3. `ai-board card submit <id> --resubmit --reason "<直した点>"`

### `implement` — タスクを 1 つ倒す（倒し終えていれば Ready にする）

計画は `.ai-board/plans/<id>.md` か `.ai-board/plans/archive/<id>.md` にある。

- **未チェックのタスクがある:** 上から最初の 1 つ（インデントされたサブタスクも 1 つと数える）だけを実装する。
  品質ゲート `npm run typecheck && npm run lint && npm run format:check && npm test` を通し、計画のそのタスクに `[x]` を付けてコミット → push。
  ゲートを通せなければコミットせず、止まって報告する
- **全部倒れていて、計画がまだ `plans/` にある:** `/code-review` で PR の差分を見直し、指摘を直してゲートを通してコミット → push。
  次に `git mv .ai-board/plans/<id>.md .ai-board/plans/archive/<id>.md` をコミット（`chore: 〜の計画を archive へ移す`）→ push → `gh pr ready <mr>`
- **計画が既に `plans/archive/` にある:** 前の周で `gh pr ready` だけが失敗している。`gh pr ready <mr>` だけをやり直す

## 4. 報告

何をしたか、次に人が見るべきもの（PR の URL、判断待ちのカード）を 3 行以内で書く。

## ハードルール

- 1 回の呼び出しで 1 手だけ。`next` 以外のカードに触らない
- `startedAt` / `rank` / `skipGates` を書かない。アイデアの表の区切り線も動かさない
- `## レビュー` に書いてよいのは 提出 / 再提出（`ai-board card submit`）だけ。承認 / 否決 / 中止 は人が書く
- 計画レビュー / PR中 のカードに触らない。PR をマージしない
- 品質ゲートを通らないままコミットしない
- カード ID・ブランチ名・PR 番号を推測で作らない。見つからなければ止まって報告する
- コミットは日本語の Conventional Commits。コミットと PR 本文の末尾の署名は、そのセッションの指示に従う
