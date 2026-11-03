---
id: loop-permissions
title: ユーザは、ループを回すときに許可の確認で何度も止められたくない
created: '2026-10-31T06:52:00.967Z'
skipGates: []
branch: loop-permissions
mr: null
---

## アイデア

ループを回すのに要る操作の許可ルールを、`.claude/settings.json` に入れてリポジトリに同梱する。

- **許す。** ファイルの読み取り、品質ゲート（`npm run typecheck` など）、`ai-board` の CLI、決まった `git` / `gh` の操作（commit / push / `gh pr create --draft` / `gh pr ready` など）
- **禁じる。** DB の直接操作（`sqlite3 .ai-board/board.db`）、`git push --force`、`main` への直接の push など、ハーネスの境界を壊す操作
- **許可ルールもハーネスの一部として説明する。** 何を許し何を禁じたかと、その理由を `harness-guide` に書く

## 背景

ループの作業者は、1 手のあいだに git・gh・npm・ai-board の CLI を何度も呼ぶ。
許可ルールが無いと、受講者は確認の応答に追われ、ループが「止まっている」ように見える。
2026-10-31 には、自動許可の判定が実装の開始を自己承認と見なして止めたこともあった。
許すものと禁じるものを明文化しておけば、受講者が場当たりで何でも許すことも防げる。
