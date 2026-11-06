---
id: skills-decide-wording
title: AIエージェントは、手順書で、無い画面のボタンではなく今の判断の入口を人に案内したい
created: '2026-11-06T04:21:21.166Z'
skipGates: []
branch: null
mr: null
---

## 背景

画面とサーバを外した（ADR 0017）後も、ループの手順書には「判断のボタン」という言い回しが残っている。
場所は `.claude/skills/board-loop/SKILL.md` の 2 か所（止まりの説明と、`止まった` カードの伝え方）と、`.claude/skills/board-loop/rules.md` の 2 か所（保留の理由の書き方）である。
今は人がボタンを押すのではなく、`ai-board decide` か、チャットで頼んで `board-decide` で判断を書く。
PR #88（`cli-rules-to-usecases`）では、`src/` のコメントとテスト名だけを掃除し、`docs/` と `.claude/` は対象から外していた。
意味は通じるが、手順書を読むエージェントが、無い画面を前提に人へ案内しかねない。

## アイデア

手順書の「判断のボタン」を、今の判断の入口（`ai-board decide`、チャットでの `board-decide`）に合わせて書き直す。
言い回しの直しで振る舞いは変わらないので、`.claude/HARNESS_VERSIONS.md` の版は上げない見込みだが、計画で確かめる。
`docs/`（ADR を含む）と README にも同じ前提の記述が残っていないかを一緒に確かめる。画面を外した経緯に触れる記述は残す。
