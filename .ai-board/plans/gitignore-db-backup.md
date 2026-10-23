# board.db のバックアップも git の追跡から外す

## 提案

### Why

`board.db` はカードの正本で、各自のローカルに置いて共有しないものである。
ところが `board.db.bak-20261023` のように退避したバックアップは、`.gitignore` に当たらず git の未追跡ファイルとして出てくる。
読み取りで開いたときにできる `board.db.bak-20261023-shm` / `-wal` も同じである。
このまま `git add -A` すると、カードの中身がリポジトリに載ってしまう。

`.gitignore` の `/.ai-board/board.db-*` は WAL / SHM（`board.db-wal` / `board.db-shm`）のためのもので、
`board.db.bak-…` のように `board.db` の直後が `-` でない名前には当たらない。

### What Changes

- `.gitignore` の `/.ai-board/board.db` と `/.ai-board/board.db-*` の 2 行を、`/.ai-board/board.db*` の 1 行にまとめる
- 直上のコメントに、バックアップも含むことを書き足す

### Impact

- 変更: `.gitignore` だけ。コード・テスト・ドキュメントには触らない
- `.ai-board/` の下で `board.db` から始まる名前のファイルは git に載っていない（`git ls-files .ai-board` で確かめた）ので、隠れてしまう共有ファイルは無い

## 設計

### Decisions

#### パターンは `board.db*` にする

`board.db.bak-*` のようにバックアップの名前を決め打ちにすると、`board.db.old` や `board.db.20261023` のような別の付け方を取りこぼす。
DB から派生したファイルはどれも共有しないので、`board.db` で始まる名前をまとめて外す。
先頭の `/` は残し、`.ai-board/` の直下だけに効かせる（今の行と同じ）。

#### ドキュメントは変えない

README と CLAUDE.md には DB の退避の手順が書かれていない。`.gitignore` のコメントで足りる。

### Risks / Trade-offs

- **`board.db` で始まる共有ファイルを将来足すと、黙って無視される。** 今は該当が無い。足すときは別の名前にする

### Non-Goals

- `AI_BOARD_DB` で `.ai-board/` の外に置いた DB の扱い（置き場所は使う人が決める）
- 退避の手順を CLI やドキュメントに足すこと

## タスク

- [x] `.gitignore` の DB の 2 行を `/.ai-board/board.db*` の 1 行にまとめ、コメントにバックアップも含むことを書く
- [x] `git check-ignore -v` で `board.db` / `board.db-wal` / `board.db-shm` / `board.db.bak-20261023` / `board.db.bak-20261023-shm` が無視され、`config.example.yaml` と `plans/` が無視されないことを確かめる

### 記録

PR #30 はタスク 2 の前に人が Ready にしてマージしたため、タスク 2 の確認と archive への移動は別の PR で行った。
確認は `git check-ignore --no-index` で、マージ後の `origin/main` の `.gitignore` に対して行った。
