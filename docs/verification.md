# ai-board 動作確認ガイド

ai-board は、人がカードを起票し、AI エージェントが計画を書いて実装し、人は計画と PR の 2 か所で判断する開発用のボードである。
この文書は、ai-board を自分の環境に用意し、空のボードと、アイデアカードを入れたボードが表示できるところまでを確かめてもらうための手順書である。
README などほかの文書は読まず、この文書だけで進めてほしい。足りない情報があれば、それ自体が見つけてほしい問題である。
着手・計画・実装といった AI のループは今回の範囲に含めない。

確かめてほしいのは次の 3 点である。

1. この文書の手順だけで準備が終わるか
2. 空のボードとアイデア投入後のボードが期待どおりに見えるか
3. つまずいた箇所と、そのときのメッセージ

## 実行前提

次の 4 つがそろっていれば始められる。
カードの置き場所は fork の `main` の `.ai-board/` なので、fork の `main` に直接 push できる必要がある（PR 必須のブランチ保護を入れない）。

| 要るもの           | 条件                                                                                                 | 確かめるコマンド              |
| ------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------- |
| Node.js            | 24 以上（`package.json` の `engines`）                                                               | `node -v`                     |
| git                | 版の指定なし                                                                                         | `git --version`               |
| GitHub CLI（`gh`） | `gh auth login` でログイン済み。ai-board はトークンを受け取らず、PR の問い合わせを `gh api` に任せる | `gh auth status`              |
| Claude Code        | チャットで頼むときに使う。ログインの種類は問わない                                                   | `claude` を起動して `/status` |

ほかに、GitHub でこのリポジトリを fork できるアカウントが要る。
Windows は Git Bash で動かす（PowerShell / cmd は想定外で、テストも Windows を対象にしていない）。
確認した OS と、上の各コマンドの出力を報告に添えてほしい。

## セットアップ

fork してビルドし、置き場所を始めれば準備は終わる。
手順は「チャットで頼む」か「コマンドを打つ」のどちらでも進められる。チャットは clone の根で `claude` を起動し、「」の文を送る。

1. GitHub でこのリポジトリを fork し、clone する。「Copy the `main` branch only」は入れたままでよい

   ```bash
   git clone https://github.com/<you>/ai-board.git
   cd ai-board
   ```

2. 依存を入れてビルドする（チャットなら「依存を入れて CLI をビルドして」）

   ```bash
   npm ci
   npm run build
   ```

3. `.ai-board/config.yaml` の `github.repository` を `<you>/ai-board` にして、main にコミットして push する。PR を問い合わせる先になる
   - チャットなら「.ai-board/config.yaml の repository を <you>/ai-board にして、main にコミットして push して」
   - カードの置き場所（`store.remote` / `store.branch`）は既定の `origin` の `main` のままにする
4. 置き場所を始める（チャットなら「置き場所を用意して」）

   ```bash
   node dist/cli.js store init
   ```

   `置き場所を始めました（.ai-board/board.yaml と order.yaml を push しました）` と出れば成功である。fork の `main` に `chore(board): 置き場所を始める` のコミットが増える

用意はカードが 0 枚のボードで終わる。アイデアは後の節で入れる。

カードは `main` の `.ai-board/`（`board.yaml`・`order.yaml`・`cards/<id>/card.md`・`cards/<id>/log/`）にファイルで置く。
CLI は読むたびに `origin` の `main` を fetch し、書き込みはそのコミットとして push する。これらのファイルを手で触らないでほしい。
手元の `main` は `git pull` すれば追いつく。

## 空のボードを表示する

置き場所を用意した直後は、カードが 0 枚のボードが出れば成功である。ターミナルとページの 2 通りで確かめる。

### ターミナルで見る

チャットで「ボードの状態を見せて」と頼むか、次を打つ。

```bash
node dist/cli.js status
```

期待する出力は次のとおり。

```text
GitHub: 接続済み
ループ: 記録なし

判断待ち (0)

AI 作業中 (0)

次の一手: なし（AI が進められるカードはありません）
```

「GitHub:」の行が「接続済み」でなければ、その行に理由が出る（トラブルシュートを参照）。

### ページで見る

チャットで「ボードを見せて」と頼むと、`board-view` のスキルがページを `.ai-board/local/board.html` に書き出し、そのパスを伝える。ブラウザで開いて見る。
ページは頼んだ時点の写しなので、新しくするには頼み直す。

| 場所           | 空のボードでの表示                                                      |
| -------------- | ----------------------------------------------------------------------- |
| 見出し         | ai-board ボード                                                         |
| 上の帯         | 「GitHub: 接続済み」「ループ: 記録なし」「次の一手: なし…」と作った時刻 |
| 判断待ち（0）  | 人の判断を待っているカードはありません。                                |
| AI 作業中（0） | AI が進めているカードはありません。                                     |
| アイデア（0）  | アイデアはありません。                                                  |
| 下の注記       | 判断はこのページからは書けません。チャットで頼んでください。            |

## 初期のアイデアを入れて表示する

`.ai-board/seed/` にある 10 枚のアイデアカードを入れ、アイデアの列に 10 枚出れば成功である。
題材の `status-stage-counts`（「ユーザは、status で列ごとの枚数を見たい」）と、ai-board 自身のアイデア 9 枚である。
`.ai-board/seed/order.txt` の順に付き、先頭にはボードのページの見た目を直す 4 枚（`board-view-*`）が並ぶ。

### 入れる

チャットで「最初のアイデアカードを入れて」と頼むか、次を打つ。起票は 1 枚ずつ `main` へのコミットとして push される。

```bash
node dist/cli.js store seed
```

```text
board-view-idea-cards: 起票しました
board-view-wait-accent: 起票しました
board-view-title-link: 起票しました
board-view-relative-time: 起票しました
board-artifact-loop-republish: 起票しました
board-events: 起票しました
decision-notify: 起票しました
refactor-cli-usecase-entry: 起票しました
retro-decisions: 起票しました
status-stage-counts: 起票しました
```

もう一度走らせると、どのカードも「<ID>: 既にあるので飛ばしました」と出て、重複しない。

### 確かめる

**ターミナルの `status` は、空のボードと同じ出力のままである。** 人向けの `status` は判断待ちと AI 作業中だけを出し、アイデアは出さない。
アイデアは次のどれかで確かめる。

| 確かめ方                                         | 期待する結果                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `node dist/cli.js card list`                     | JSON の配列に 10 件。どれも `startedAt` / `branch` / `pr` は `null`                                                                                                            |
| `node dist/cli.js card show status-stage-counts` | frontmatter と、本文の `## アイデア` / `## 背景`                                                                                                                               |
| チャットで「ボードを見せて」                     | ページの「アイデア（10）」に、上の起票の順でタイトルと ID（先頭は `board-view-idea-cards`）。その下に点線の区切り「ここから下はあとで考える」。判断待ちと AI 作業中は 0 のまま |

### 自分で 1 枚書く（任意）

チャットで次のように頼むと、アイデアの末尾に 1 枚足される。ページを頼み直して、アイデアが 11 枚になることを確かめてほしい。

> 「ユーザは、status で中止のカードの枚数も見たい」というアイデアカードを、ID を status-aborted-count にして起票して。背景は、片付けたカードがどれだけあるかが分からないこと。

## 確認チェックリスト

- [ ] `node -v` が 24 以上、`gh auth status` がログイン済み
- [ ] `npm ci` と `npm run build` がエラーなく終わる
- [ ] 「置き場所を用意して」（`store init`）で、fork の `main` に `.ai-board/board.yaml` と `order.yaml` が入る
- [ ] `status` が「GitHub: 接続済み」と判断待ち (0)・AI 作業中 (0) を出す
- [ ] 「ボードを見せて」で空のページが開く
- [ ] 「最初のアイデアカードを入れて」の後、`card list` が `status-stage-counts` を含む 10 件を返す
- [ ] 「ボードを見せて」を頼み直すと、アイデア（10）に 10 枚が出る
- [ ] （任意）自分で起票したカードがアイデアの末尾に付く
- [ ] （任意）別の PC で clone してビルドすると、`card list` で同じカードが見える
- [ ] （任意）2 台から同じカードに判断を書くと、どちらの判断も `card show` の `## レビュー` に残る

## トラブルシュート

CLI は失敗すると、次にすることを 1 行で出す。下の表の「症状」は実際に出る文面である（パスなどは環境で変わる）。

| 症状（出る文面）                                                   | 原因                                                   | 対処                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `npm ci` で `EBADENGINE` の警告                                    | Node が 24 より古い                                    | Node 24 以上を入れて `npm ci` からやり直す                                                |
| `…/dist/cli.js は HEAD のコミットより古い。ビルドし直してください` | `git pull` の後にビルドしていない                      | `npm run build`                                                                           |
| `置き場所が空です（.ai-board/board.yaml がありません）…`           | `store init` を走らせていない                          | `node dist/cli.js store init`                                                             |
| `置き場所のリモート origin がこのリポジトリにありません…`          | clone ではなく `git init` したリポジトリなど           | `git remote add origin <URL>` か、`config.yaml` の `store.remote` を直す                  |
| `置き場所の git の操作（fetch）に失敗しました: …`                  | ネットワークに出られない・`origin` を読めない          | `git fetch origin` が通るか確かめる                                                       |
| `置き場所の git の操作（push）に失敗しました: …`                   | `main` に push できない（ブランチ保護・権限）          | `git push origin main` が通るか確かめる。PR 必須の保護を外す                              |
| `置き場所への push が 3 回とも先を越されました…`                   | ほかの人が続けて書いている                             | 少し待ってやり直す                                                                        |
| `GitHub: 使えません（gh の終了コード 4 で失敗した）`               | `gh` にログインしていない                              | `gh auth login`                                                                           |
| `GitHub: 使えません（gh の終了コード 1 で失敗した）`               | `github.repository` が存在しない・見られないリポジトリ | fork の `<you>/ai-board` に書き換える。`gh repo view <you>/ai-board` で見られるか確かめる |
| `…/config.yaml の内容が不正です: …`                                | `config.yaml` の書き方の誤り（例: `repository: null`） | 連携しないなら `github:` の節ごと消す。値は `'owner/repo'` の文字列で書く                 |
| `ほかの ai-board が置き場所に書いています（…）`                    | 別の CLI が同時に書いている                            | 少し待ってやり直す                                                                        |
| `置き場所の形の版（…）が、この CLI の版（…）と違うため読みません`  | 手元の CLI が古い                                      | `git pull` して `npm run build`                                                           |
| アイデアを入れたのに `status` が変わらない                         | 人向けの `status` はアイデアを出さない（仕様）         | `card list` か「ボードを見せて」で確かめる                                                |
| ページが古いまま・アイデアが 0 件のまま                            | ページは頼んだ時点の写し                               | 「ボードを見せて」と頼み直す                                                              |

fork の `main` を汚さずに試したいときは、試しの置き場所（手元の bare のリポジトリ）を `AI_BOARD_STORE` で指す。本物の置き場所には届かない。

```bash
STORE="$(mktemp -d)/store.git"
git init --quiet --bare --initial-branch=main "$STORE"
export AI_BOARD_STORE="$STORE"
node dist/cli.js store init
node dist/cli.js store seed
node dist/cli.js status && node dist/cli.js card list
```

## フィードバックの返し方

つまずいた箇所ごとに、次の 4 つを書いて依頼者に返してほしい。

1. どの手順か（チェックリストの項目）
2. OS と、`node -v` / `gh --version` / Claude Code の版
3. 出た文面をそのまま（チャットで頼んだなら、頼んだ文と Claude の返事）
4. 期待していた結果

この文書の分かりにくい言い回しや足りない情報も、動作の不具合と同じく歓迎する。
