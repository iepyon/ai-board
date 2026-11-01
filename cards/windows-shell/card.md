---
id: windows-shell
title: ユーザは、Windows でも手順書のシェルを書き換えずにループを回したい
created: '2026-10-31T06:52:00.276Z'
skipGates: []
branch: null
mr: null
---

## アイデア

スキルと作業者の手順書（`.claude/skills/` と `.claude/agents/`）を、Windows でも書き換えずに回せるようにする。

- 手順書の中の `jq`（8 か所）や `sed` を、`ai-board` のサブコマンドか `node` の 1 行に置き換える。例えば `status --json` から要る項目だけを取り出すのは、`ai-board status` の側で出せるようにする
- 想定するシェルは、Windows の Claude Code が使う Git Bash にする。パスの書き方（`/c/...` と `C:\...`）で壊れないかを確かめる
- CI に Windows の行を足し、品質ゲートとビルドが Windows でも通ることを確かめる

## 背景

研修の受講者には Windows の人がいる。
今の手順書は macOS の端末を前提に書いてあり、`jq` は Git Bash に入っていない。
受講者がそこで止まると、ハーネスの中身ではなく環境の問題で研修の時間が消える。
