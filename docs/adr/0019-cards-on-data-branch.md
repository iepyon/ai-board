# 0019. カードを git のデータ用ブランチ `ai-board/data` に置き、書くたびにコミットと push をする

- 状態: 採用
- 日付: 2026-11-01
- 置き換え元: [0009](0009-cards-in-sqlite.md)・[0010](0010-share-main-checkout-data.md)（一部）
- 置き換え先: なし

## 状況

外出中に、スマホの Claude Code アプリからクラウドのセッションを立ち上げて、人の判断と AI の作業を回したかった。
手元の Mac を動かし続ける前提にはしない。人は GitHub のアプリでは作業しない。

カードは [0009](0009-cards-in-sqlite.md) で `.ai-board/board.db`（SQLite）に置いており、git に載らない。
クラウドのセッションは毎回新しい clone から始まり、push したもの以外は残らないので、カードが見えなかった。
ワークツリーからはメインのチェックアウトの `board.db` を共有していた（[0010](0010-share-main-checkout-data.md)）。

SQLite に移した狙いは、書き込みを `ai-board card` の CLI に絞ることだった。
ただし `sqlite3` で直接触らないことは手順書の決まりで守っているだけで、技術的には止めていなかった。

クラウドのセッションには次の制約があった。

- GraphQL が 403 で、手順書が使う `gh pr create / view / edit / ready / comment / diff` が動かない
- `gh auth status` が「GH_TOKEN が無効」と失敗する。`gh api`（REST）は動く。このままでは `forge.status` が `connected` にならず、`status` の `next` が `null` でループが回らない
- 常駐のサーバが無い。ルーティンは最短 1 時間で、`run_once_at` のルーティンが 3 回動いたことがある

## 決定

**カードの正本を、orphan のデータ用ブランチ `ai-board/data` のテキストに移す。SQLite は持たない。書き込みのたびにコミットと push をする。**

- 1 カード 1 ディレクトリ（`cards/<id>/card.md`）。判断は 1 件 1 ファイル（`cards/<id>/log/<時刻>.<gate>.<種別>.md`）で、追記だけにして書き換えも削除もしない。
  `## レビュー` と `startedAt` は `log/` から組み立てる。並び順と区切り線は `order.yaml`、形の版は `ai-board-data.yaml`
- `stage-resolver.ts` と `review-log.ts` の入力は変えない。リポジトリのインターフェースと usecase も変えず、実装だけを差し替える
- **書き込みは 1 操作にまとめる。** ロック → 取り直し（fetch と `reset --hard`）→ 検査 → コミット → push。
  **push が拒否されたら rebase せず、取り直して検査からやり直す。** push の拒否を楽観ロックに使う
- 手元では、メインのチェックアウトの `.ai-board/data/` にデータのワークツリーを 1 か所置き、どのワークツリーからもそこを見る。
  試すときは `AI_BOARD_DATA` で別の clone を指す（`AI_BOARD_DB` を置き換える）
- `config.yaml` はデータ用ブランチの根から読み、無ければ `.ai-board/config.yaml` を読む
- マージ済みの PR の控えはデータ用ブランチの `snapshots/` に、開いている PR の控えは git に載せない使い捨ての JSON に置く
- **データのワークツリーへの直接の書き込みとデータ用ブランチへの直接の push は、`.claude/settings.json` の deny ルールで止める。** この設定はクラウドでも効く
- 手順書の `gh pr` を、REST で行う `ai-board pr` に置き換える。Ready にするときだけ `gh pr ready` を試し、失敗したらクラウドの `ccr/ready_for_review` を試す
- GitHub の接続の確かめを `gh auth status` から `gh api repos/<owner>/<repo>` に変える
- クラウドではボードを `ai-board status --html` の HTML にし、会話のセッションが Artifact として公開する
- 人の判断は人の API で書く。CLI に人の判断の入口は足さない。サーバが無ければ `board-decide` がそのセッションで起動して叩き、終わったら止める
- 切り替えは人が `ai-board migrate` を 1 回走らせて行う。`ai-board import` は消し、`node:sqlite` は古い DB を読むためだけに残す

## 検討した代案

- **GitHub Issues にカードを置く** — クラウドでは GraphQL が使えないので、並び順を置く先にしていた Projects が使えない。
  セッションごとに REST で読み直すと問い合わせが増える。人が GitHub の画面で読むという Issues の利点を、この使い方では使わない
- **SQLite のまま DB ファイルをデータ用ブランチに載せる** — バイナリの差分は rebase も確かめもできず、判断の履歴もコミットに残らない
- **push が拒否されたら rebase する** — 離れた行の編集を git が黙って混ぜ（`order.yaml` で確かめた）、検査を経ないままの状態が push されうる
- **CLI に人の判断の入口を足してクラウドで書く** — `CLAUDE.md` の「CLI に入口を足すときはこの境界を崩さない」に反する
- **ボードの Artifact に Artifact の型（Dashboard など）を使う** — 型はアカウントごとに違い、手元のテストで形を確かめられない
- **ETag と 304 で問い合わせを節約する** — 今の指紋で足り、`gh` が 304 で終了コード 1 を返す扱いを足すと複雑になる（Non-Goals）
- **判断のファイル名に日本語の種別を使う** — `git` の出力で引用符付きにエスケープされ、人が読みにくい

## 結果

- クラウドのセッションだけでボードを回せるようになった。clone した時点でカードが揃い、読むのに API を使わない
- 判断ごとにコミットが残り、人の判断の痕跡が辿りやすくなった
- 2 つの clone から同じカードに同時に書いても 1 つだけが通る。ルーティンの重複起動はこれで 1 つにまとまる
- 書き込みが遅くなった。画面のボタン 1 回ごとに fetch と push が走る。オフラインでは書けず、push の失敗は 503 になる
- ファイルを直接書き換える道が開き、守りは deny ルールに変わった。Bash の書き方次第ですり抜けられるのは `sqlite3` のころと同じである
- 形の版を上げて push すると、古い版の CLI はカードを読めずに止まる。ワークツリーで形を変えるコードを試すときは、`AI_BOARD_DATA` で bare リポジトリを `origin` にした clone を指す決まりになった
- `ccr/` の経路はクラウドの内部の口で、変わると Ready にできなくなる
- 判断の書き込みは、本文の差分から足された判断を推し量る形で始まった。理由に判断の見出しの行を混ぜると別の判断が書けたので、まず CLI で拒み（`1108fec`）、
  後に [0022](0022-review-append-port.md) で判断を値のまま追記する口に置き換えた
- ロックの待ちの上限（5 秒）と、死んだロックの取り直しの競合は、AI レビューで人の判断に回したまま残った
- ループの 1 手の記録も、後にデータ用ブランチの `loop/` に置いた（[0024](0024-loop-activity-log.md)）

## 根拠

- 計画: `.ai-board/plans/archive/issue-store.md`
- カード: データ用ブランチの `cards/issue-store/card.md`（`## 背景` に Issues を退けた 3 つの理由）
- コミット: `b3fa09a` データ用ブランチのカードのファイルの形を読み書きする純関数を足す
- コミット: `dcb4159` データ用ブランチのワークツリーを読み書きする DataStore を足す
- コミット: `11c690b` card の CLI と status を、データ用ブランチを取り直して読み、書き込みを transact の中で走らせる
- コミット: `8566331` GitHub の接続の確かめを gh auth status から gh api のリポジトリの取得に変える
- コミット: `4d7fe32` ai-board migrate を足して import を消し、SQLite を移行の読み出しだけに縮める
- コミット: `b5716af` gh pr を REST で置き換える ai-board pr を足す
- コミット: `2097846` .claude/settings.json でデータのワークツリーへの直接の書き込みとデータ用ブランチへの push を deny にする
- コミット: `1108fec` 提出と保留の理由に判断の見出しとして読める行があれば拒む
- 前の判断: `b97280b` カードの正本を SQLite に移し、エージェントは ai-board card で書く
- PR: #54
