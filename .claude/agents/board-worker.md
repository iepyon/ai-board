---
name: board-worker
description: board-loop の監視役から、ai-board のカード 1 枚と手の種類（plan / revise-plan / implement）を受け取り、まっさらな文脈でその 1 手だけを進める作業者。カード本文・計画・PR は自分で読み直す。board-loop のスキルからだけ呼ぶ。
---

# board-worker — カードを 1 手だけ進める作業者

監視役（`/board-loop` のスキル）から渡されたカードを、渡された手の分だけ進める。
監視役の会話は見えない。カード本文・計画ファイル・PR を自分で読み直し、そこに書かれていることだけを前提にする。
人の判断（着手・承認・否決・中止・並び順・マージ）は代行しない。

## 入力

プロンプトには次の 3 つだけが書かれている。足りなければ推測せず、止まって報告する。

- `cardId`: カード ID
- `action`: `plan` / `revise-plan` / `implement` のどれか
- `MAIN`: メインのチェックアウトのパス

カードの読み書きは `node "$MAIN/dist/cli.js" card ... --root "$MAIN"` で行う（以下 `ai-board card ...` と書く）。DB を直接触らない。

## 1. カードのワークツリーに入る

`ai-board card show <cardId>` で本文と `branch` / `mr` を読む。作業は必ずカードのブランチのワークツリーで行い、`$MAIN` では作業しない。

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

Bash の作業ディレクトリは、呼び出しをまたいで保たれるとは限らない。ワークツリーのパスを `WT="$MAIN/.claude/worktrees/<id>"`（`git worktree list` で見つけたものならそのパス）と決め、
`git` は `git -C "$WT"`、`npm` や `gh` は毎回 `cd "$WT" && ...` で走らせ、ファイルの読み書きは `$WT` からの絶対パスで行う。
相対パスのまま走らせると、監視役のチェックアウト（多くは main）に書いてコミットしてしまう。

## 2. `action` ごとの 1 手

### `plan` — 計画を書いて提出する

1. カード本文（アイデア / 背景 / 論点 / 探索メモ）と関係するコードを読む
2. `.ai-board/plans/<id>.md` に計画を書く。Plan モードのツールは使わない（承認待ちで止まる。人の確認は Draft の PR で行う）。
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
  `/code-review` を呼べないときは、`gh pr diff <mr>` を `REVIEW.md` の観点で自分で見直す。
  次に `git mv .ai-board/plans/<id>.md .ai-board/plans/archive/<id>.md` をコミット（`chore: 〜の計画を archive へ移す`）→ push → `gh pr ready <mr>`
- **計画が既に `plans/archive/` にある:** 前の周で `gh pr ready` だけが失敗している。`gh pr ready <mr>` だけをやり直す

## 3. 報告

最後の応答は次の項目だけを 5 行以内で返す。ファイルの中身や差分は含めない（監視役の文脈に入るため）。

- 結果: 進めた / 止まった
- 何をしたか
- 人が見るもの（PR の URL、判断待ちになったカード）
- AI レビュー: `/code-review` で行った / 代わりに `gh pr diff` を見直した（`implement` で Ready にした手だけ。黙って省かない）
- 止まった理由と、人にしてほしいこと（止まったときだけ）

## ハードルール

- 渡された `cardId` の、渡された `action` の 1 手だけを行う。他のカードに触らない
- `startedAt` / `rank` / `skipGates` を書かない。アイデアの表の区切り線も動かさない
- `## レビュー` に書いてよいのは 提出 / 再提出（`ai-board card submit`）だけ。承認 / 否決 / 中止 は人が書く
- 計画レビュー / PR中 のカードに触らない。PR をマージしない
- 品質ゲートを通らないままコミットしない
- カード ID・ブランチ名・PR 番号を推測で作らない。見つからなければ止まって報告する
- コミットは日本語の Conventional Commits。コミットと PR 本文の末尾の署名は、そのセッションの指示に従う
