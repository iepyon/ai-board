# 0009. カードの正本をファイルから SQLite に移し、エージェントは `ai-board card` の CLI で書く

- 状態: 置き換え済
- 日付: 2026-09-26（PR #10 のマージ）
- 置き換え元: なし
- 置き換え先: [0019](0019-cards-on-data-branch.md)

## 状況

カードは `.ai-board/cards/<id>.md` に 1 ファイル 1 カードで置き、git に載せていた。
サーバはカードファイルの唯一の書き手とされ、AI エージェントは本文とリンク欄だけを書く、という書き込み境界を `CLAUDE.md` に書いていた。
カードはエディタで直接編集してよく、ファイル監視から SSE でブラウザへ反映していた。

エージェントのハードルール（`startedAt` を打たない、`## レビュー` に書くのは 提出 / 再提出 だけ、`skipGates` と `rank` を書かない）は、
ファイルを直接書ける以上、手順書で守らせるしかなかった。

SQLite を選んだ理由は、PR #10 の本文に「Node 組み込みの `node:sqlite` を使う（依存は増やさない）」とあるだけで、ファイルをやめる理由そのものは書かれていない。
PR の本文は、ハードルールのうちカードに関わるものが運用ではなく仕組みで守られるようになることを変更点に挙げている。

## 決定

カードの正本を `.ai-board/board.db`（SQLite）に移す。

- Node 組み込みの `node:sqlite` を使い、依存を増やさない。そのために `engines` を `>=22.13.0` に上げる。
- DB は `.gitignore` に入れ、git に載せない。
- **AI エージェントはカードを `ai-board card` の CLI で読み書きし、DB を直接触らない。**
- **CLI には `startedAt` / `rank` / `skipGates` を書く入口も、承認 / 否決 / 中止を追記する入口も持たせない。**
  `body` の差し替えは `## レビュー` のエントリが変わるものを拒む。
- `## レビュー` は正規化せず、従来どおり本文の Markdown に残す。usecase・`stage-resolver.ts`・画面のロジックは変えない。
- 別のプロセス（CLI）の書き込みは `PRAGMA data_version` のポーリングで拾い、サーバ自身の書き込みはリポジトリの `onWrite` から SSE に流す。
- 既存のカードは `ai-board import` で取り込み、`.ai-board/cards/` を削除する。

## 検討した代案

記録なし。

## 結果

- カードに関わるハードルールを CLI が構造で強制するようになった。「CLI に入口を足すときはこの境界を崩さない」は今も `CLAUDE.md` に残っている。
- PR #10 が注意として書いたとおり、**バックログは git で共有されなくなった。** ai-board を使う他のプロジェクトでも一度 `ai-board import` が要った。
- `card list` はステージを出さない。PR の状態はサーバのメモリにしか無かったため。
- DB が git に載らないので、ワークツリーごとに `board.db` ができてカードの変更が散らばった。
  これはワークツリーからメインのチェックアウトの DB を共有する形で埋めた（[0010](0010-share-main-checkout-data.md)）。
- 毎回新しい clone から始まるクラウドのセッションからはカードが見えなかった。
  [0019](0019-cards-on-data-branch.md) でカードを git のデータ用ブランチ `ai-board/data` に移し、この判断を置き換えた。
  `node:sqlite` は古い DB を `ai-board migrate` で読み出すためだけに残った。
- CLI で書かせる決定と、CLI に人の判断の入口を持たせない境界は、[0019](0019-cards-on-data-branch.md) でも引き継がれた。

## 根拠

- コミット: `b97280b` feat: カードの正本を SQLite に移し、エージェントは ai-board card で書く
- コミット: `ef3afa3` chore: DB へ取り込んだカードファイルを削除する
- PR: #10
- 計画: `.ai-board/plans/archive/board-seed.md`（DB が git に載らないことで起きた問題）
- 計画: `.ai-board/plans/archive/issue-store.md`（置き換えの理由）
- `CLAUDE.md`「書き込み境界」（`b97280b` 時点と現在）
