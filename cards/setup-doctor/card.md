---
id: setup-doctor
title: ユーザは、最初の 1 周を回す準備が整っているかを、1 つのコマンドで確かめたい
created: '2026-10-31T06:52:00.749Z'
skipGates: []
branch: null
pr: null
---

## アイデア

最初の 1 周を回す準備が整っているかを確かめる `ai-board doctor` を足す。

- 確かめること: Node の版、`gh` のログイン、`.ai-board/config.yaml` の `github:` が自分の fork を向いているか、`dist/` のビルド、DB が開けるか、題材のカードを取り込んだか、Claude Code のスキルとサブエージェントが見えるか
- 足りないものは、何をすれば直るかを 1 行で出す。自分では直さない（設定を書き換えない）
- 出力は人向けの数行と、`--json`。研修の講師が受講者の状態を集めやすいようにする

## 背景

研修では、受講者が fork してから最初の 1 周を回すまでに、Node・gh のログイン・config.yaml の向き先・ビルドなど、つまずく所がいくつもある。
今はループが止まってから、`status` の出力や作業者の報告で原因を探すしかない。
始める前に 1 つのコマンドで確かめられれば、講師が一人ずつ見て回らなくて済む。

## 探索メモ

2026-11-03 に loop-permissions（PR #68）を回して分かった、確かめる項目の候補。

- **auto モードで動くか。** 許可ルールは auto モードを前提に allow を最小（4 行）にした。auto モードで動かないと確認が頻繁に出る。
  auto モードは CLI が v2.1.283 以上なら既定の開始モードだが、対応していないモデルと、管理設定の `permissions.disableAutoMode` では使えない
- **ワークスペースを信頼済みか。** 信頼の確認に応じていないワークスペースでは、プロジェクトの `.claude/settings.json` の allow が無視される
  （`claude -p` で「Ignoring 4 permissions.allow entries from .claude/settings.json: this workspace has not been trusted」と出た）。
  受講者が clone した直後に Claude Code を開き、信頼の確認に「はい」と答える手順が要る
- **許可ルールの警告が出ないか。** `claude -p` を起動したときの許可ルールの警告（照合されないルールなど）を拾えると、設定の書き損じに気付ける
