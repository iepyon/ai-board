---
id: gitignore-db-backup
title: ユーザは board.db のバックアップを、git の未追跡ファイルとして見たくない
created: '2026-10-23T05:54:56.143Z'
skipGates: []
branch: gitignore-db-backup
mr: 30
---

## アイデア

`.gitignore` の DB の行を、`board.db` のバックアップも含むように広げる。

- 今の `/.ai-board/board.db` と `/.ai-board/board.db-*`（WAL / SHM）を、`/.ai-board/board.db*` の 1 行にまとめる
- README か CLAUDE.md に DB の退避の仕方を書いているなら、バックアップのファイル名の例もそろえる

## 背景

2026-10-23 に、ボードを空にするため `board.db` を `board.db.bak-20261023` へ退避した。
すると、このファイルと、読み取りで開いたときにできた `-shm` / `-wal` が、git の未追跡ファイルとして出てきた。
`.gitignore` の `board.db-*` は WAL / SHM のためのもので、`board.db.bak-…` には当たらない。

DB はカードの正本で、各自のローカルに置いて共有しないものである。バックアップも同じ扱いで、
うっかり `git add -A` するとカードの中身がリポジトリに載ってしまう。

## 論点

- **パターンの広さ。** `board.db*` にすると、`board.db` で始まる名前はすべて無視される。
  意図せず隠れるファイルが無いか（`.ai-board/` の下に `board.db` で始まる、共有すべきファイルは無いはず）
