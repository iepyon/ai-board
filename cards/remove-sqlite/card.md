---
id: remove-sqlite
title: ユーザは、移行が済んだ今、SQLite への依存をコードから残らず消したい
created: '2026-11-03T09:56:28.829Z'
skipGates: []
branch: null
mr: null
---

## アイデア

SQLite への依存を残らず消す。カードの正本はすでにデータ用ブランチに移っていて、npm の依存にも SQLite は無いが、
移行用の `ai-board migrate` が Node に組み込みの `node:sqlite` で古い `.ai-board/board.db` を読むために、コードが残っている。
移行は済んでいるので、`migrate` ごと消す。

- **消すもの**
  - `ai-board migrate`（`src/cards/cli/migrate-cli.ts`）と、古い DB の読み出し `src/infrastructure/database.ts`
  - `src/cli.ts` の `suppressSqliteWarning()`（`node:sqlite` の ExperimentalWarning を黙らせるためだけにある。動的 import の段も要るか見直す）
  - `src/shared/config.ts` の `DB_FILE` / `legacyDbPath()`
  - `src/cli-main.ts` と `src/board/cli/loop-cli.ts` の `legacyDb`（データ用ブランチが無いときのエラーで、古い `board.db` に触れる案内）
  - テストの道具 `src/infrastructure/__tests__/legacy-database-fixture.ts` と、`migrate` / `database.ts` のテスト
- **直すもの**
  - `src/cards/models/card.ts` の docstring（「カードは `.ai-board/board.db`（SQLite）の `cards` テーブルの 1 行に対応する」が今の作りと食い違っている）
  - README の「board.db からの切り替え」と `docs/architecture.md` の SQLite の段落を、「移行は過去の版の `ai-board migrate` で行う」案内に縮める
- **残してよい見込みのもの**（計画で決める）
  - `.gitignore` の `/.ai-board/board.db*`（古いチェックアウトに残った DB を誤ってコミットしないため）
  - `.claude/settings.json` の deny の `sqlite3` と、それを見る `src/__tests__/claude-settings.test.ts`

## 背景

2026-11-03 の対話で、人が「SQLite 依存はもう消したつもりだった」と言い、調べたところ上のものが残っていた。
`4d7fe32`（issue-store）で SQLite を `migrate` の読み出しだけに縮め、そのときは移行のために残すと決めていた。

## 論点

- **移行していない人の扱い。** `migrate` を消すと、古い `board.db` しか持たない人は今の版で移行できない。移行は過去の版（消す直前のタグやコミット）で行う案内を README に残すか
- **ADR。** issue-store で `node:sqlite` を残すと決めた判断が ADR にあれば、今の形に書き直す
- **Node の版。** `node:sqlite` が無くなると、Node 24 に絞った理由のうち SQLite に関わる記述（`node-lts`）も見直すか
