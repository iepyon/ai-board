---
id: decide-guard-settings
title: ユーザは、ループのサブエージェントが人の判断を書く口を、hook で確実に使えないようにしたい
created: '2026-11-03T14:00:10.454Z'
skipGates: []
branch: null
pr: null
---

## アイデア

ループのサブエージェント（`board-planner` / `board-worker` / `board-reviewer`）の中から、人の判断を書く口（人の API の `/api/cards`・`/api/idea-divider` と `board-decide` のスキル）を、手順書の決まりだけでなく hook でも拒む。
hook は `.claude/settings.json` の `PreToolUse` に登録し、入力の `agent_id` が載り `agent_type` が `board-` で始まるときだけ拒む。

## 背景

PR #73（`decide-guard`）で、同じ hook を 3 つのエージェント定義の frontmatter の `hooks` に書いた。
2026-11-03 にクラウドのセッションで確かめたところ、frontmatter の hook はサブエージェントの中で一度も呼ばれなかった（hook の入力をファイルに書き出しても 1 行も残らなかった）。
効いていない守りを main に残さないため、PR #74 で #73 をまるごと戻した。

同じ日に確かめて分かったこと:

- 同じ hook を `.claude/settings.json` に置くと、走っているセッションのまま効いた
- 本筋のセッションの入力には `agent_id` も `agent_type` も載らない
- `board-reviewer` の中の入力には `agent_id` と `agent_type: "board-reviewer"` が載り、人の API の道を含む Bash を拒んだ
- 戻す前の直しの案（hook の `agent_type` の照合、テスト、ADR 0007 などの書き直し）は、`.claude/settings.json` への書き込みを auto モードの分類器が `[Self-Modification]` で止めたため、コミットしていない

## 論点

- **`.claude/settings.json` を誰が書くか。** ADR 0007 は「許可や hook の設定を AI が書き換えない」ことを理由に settings.json を退けていた。人が書くか、許可を足して AI に書かせるかを決める
- **`board-*` だけを止めるか、すべてのサブエージェントを止めるか。** `agent_type` を見れば `board-*` に絞れる
- **hook が本筋のすべての Bash と Skill の前にも走ること**（`agent_id` が無いのですぐ通す）を受け入れるか
- 実際の発火は単体テストでは確かめられないので、動作確認で人が見る
