# カードをファイルに同期し、git のマージに乗せる

## 提案

### Why

ワークツリーで並列に作業すると、ワークツリーごとに `board.db` ができ、カードの変更が別々の DB に散らばる。
`board.db` は git に載らないので、ブランチをマージしてもカードの変更はマージされない。
新しいワークツリーではカードが 1 枚も無いボードが開き、メインの DB を手でコピーすると、
コピーし直したときに画面の並べ替え（`rank`）を上書きして失う。

カードを 1 枚 1 ファイルで git に載せ、DB との間を同期するコマンドを足す。
マージそのものは git に任せ、衝突したときは人が普段どおりに解く。

### What Changes

- `ai-board sync [--root <path>] [--prefer file|db]` を足す。`.ai-board/cards/<id>.md` と区切り線の
  `.ai-board/idea-divider.yaml` を DB と突き合わせ、変わった側からもう一方へ写す。
- 前回の同期の内容（カードごとのハッシュ）を DB に記録する（マイグレーション v5、`sync_state` テーブル）。
  これを基準に、カードごとに「ファイルだけ変わった / DB だけ変わった / 両方変わった」を判定する（3-way）。
- 一度も同期していない空の DB を開いたとき、`.ai-board/cards/` があれば自動で取り込む。
  新しいワークツリーや clone でも、カードの入ったボードが開く。
- `ai-board import` は `sync` に置き換えて削除する（`sync` の「DB に無いカードを取り込む」が同じ働きをする）。
- 書き出しは自動にしない。DB を書き換えるたびにファイルを書くことはしない。
- ツールの `MIGRATIONS` にこのリポジトリのカードは入れない。`MIGRATIONS` は npm パッケージに入り、
  ai-board を使う別のリポジトリの DB にも流れ込むため。

### Impact

- server
  - `src/infrastructure/database.ts` — マイグレーション v5（`sync_state` テーブル）
  - `src/cards/repositories/`（新規）— `CardFileStore`（`.ai-board/cards/` と `idea-divider.yaml` の読み書き）、
    `SyncStateRepository` と SQLite 実装
  - `src/cards/repositories/card-markdown.ts` — `.ai-board/` へ書く用途が加わる（docstring の「書き込むことは無い」を改める）
  - `src/cards/usecases/commands/sync-cards.command.ts`（新規）— 3-way の判定と反映。`Result<SyncReport, SyncError>` を返す
  - `src/cards/errors/` — `SyncConflict` などのエラー種
  - `src/cards/composition.ts` — 依存の構成
  - `src/cli-main.ts` — `sync` サブコマンド、`import` の削除、空の DB の自動取り込み
  - `src/server.ts` — 起動時の空の DB の自動取り込み
  - `src/shared/config.ts` — `cardsDir` の説明、`idea-divider.yaml` のパス
- テスト: `sync-cards`（判定表の全行）、`CardFileStore`、マイグレーション v5、自動取り込み、CLI
- ドキュメント: `README.md` / `CLAUDE.md` の「タスクは board.db にある」「書き込み境界」「1 周の流れ」
- `.gitignore` は変えない（`.ai-board/cards/` は git に載せる）

## 設計

### Context

カードの正本は `board.db`（SQLite）で、画面・CLI・SSE はすべて DB を読み書きする。
カードの Markdown 表現（`card-markdown.ts`）は既にあり、`card show` の出力と移行前ファイルの取り込みに使っている。
パーサは Zod で検証し、`serializeCard` はキー順を固定しているので、往復しても差分を生まない。

### Goals / Non-Goals

**Goals:**

- ワークツリーごとのカードの変更を、コードと同じブランチのマージでまとめられること
- 別々のカードを触ったワークツリー同士が衝突しないこと
- DB で変えたのに書き出していない変更を、同期で黙って消さないこと
- 新しいワークツリーで、カードの入ったボードが開くこと

**Non-Goals:**

- ファイル経由の書き込みの検証。ファイルを直接書き換えて同期すれば `startedAt`・`rank`・`skipGates`・
  承認 / 否決 / 中止も DB に入る。これは塞がない（2026-09-27 に人が判断）
- 書き出しの自動化（DB への書き込みのたびにファイルを書く）
- `rank` の衝突の自動解決。並べ替えの振り直しで全ファイルの `rank` が変わって衝突しても、人が解く
- DB を正本から外すこと。画面・CLI は引き続き DB を読み書きする

### Decisions

#### 1 カード 1 ファイル、既存の Markdown 表現を使う

単一の `seed.sql` にすると、別々のカードを変えたワークツリー同士でも同じファイルの近い行が衝突する。
1 カード 1 ファイルなら衝突は同じカードを両方で変えたときだけになる。
形式は `card show` と同じ Markdown にする。差分が読め、パーサと検証を作り直さずに済む。

区切り線はカードではないので、`.ai-board/idea-divider.yaml`（`rank: <数値>`）に分ける。

#### 同期は 1 コマンドで、カードごとの 3-way で決める

前回の同期の内容を基準（base）として持ち、カードごとに DB・ファイル・base の 3 つを比べる。
比べるのはパースして `serializeCard` し直した文字列の SHA-256 で、ファイルの書式の揺れは差分にしない。

| base | DB | ファイル | 動作 |
| --- | --- | --- | --- |
| 無し | 無し | 有り | ファイルから DB へ取り込む（新しいワークツリー、他のブランチから来たカード） |
| 無し | 有り | 無し | DB からファイルへ書き出す（新しく起票したカード） |
| 有り | = base | ≠ base | ファイルから DB へ（マージで入った変更） |
| 有り | ≠ base | = base | DB からファイルへ（画面・CLI で変えた変更） |
| 有り | ≠ base | ≠ base | 両者が一致すれば base を進めるだけ。違えば衝突として報告し、どちらにも書かない |
| 有り | = base | 無し | ファイルが消された。DB は消さず、警告だけ出す |
| 無し | 有り | 有り | 両者が一致すれば base を記録するだけ。違えば衝突 |

衝突が 1 件でもあれば終了コード 1 で終わり、衝突しなかったカードは反映する。
`--prefer file` / `--prefer db` を付けると、衝突したカードをその側に揃える。

DB 全体のハッシュ 1 つで「書き出していない変更があれば止める」形も考えた。
しかし GitHub のポーリングが PR 番号（`mr`）を DB に書き戻すため、人が何も変えていなくても
同期のたびに止まる。カードごとに判定すれば、DB だけの変更は書き出され、ファイルだけの変更は取り込まれ、
止まるのは本当に両方で変わったときだけになる。

#### 自動取り込みは「一度も同期していない空の DB」に限る

判定は「`cards` も `sync_state` も空」で行う。`openDatabase` の戻り値は変えない。
既にカードのある DB に黙ってファイルを流し込むと、手元の変更と混ざるため、それは明示の `sync` に任せる。

#### 同期の書き込みは画面に届く

DB への書き込みは CLI からなら `data_version` 経由で、サーバの起動時の自動取り込みならその直後の初回描画で画面に出る。
新しい仕組みは要らない。

### Risks / Trade-offs

- **書き込み境界の迂回。** CLI が `startedAt` などの入口を持たないことで境界を強制してきたが、ファイル経由では
  迂回できる。README / CLAUDE.md に「ファイルを直接書き換えない」をエージェントのハードルールとして書き、
  強制はしないことを明記する
- **同期し忘れ。** ワークツリーで `sync` せずにコミットすると、カードの変更はブランチに乗らない。
  「1 周の流れ」に、PR を出す前と `git merge` / `pull` の前後に `sync` する手順を書く
- **`mr` の書き戻しによる差分。** ポーリングが番号を書き戻すたびに、次の同期でファイルが変わる。
  番号は PR を出したブランチで確定するので、その差分はブランチに乗って自然にマージされる
- **ファイルの削除。** カードを消すにはファイルと DB の両方から消す必要がある。今回は DB を消さない
- **計画ファイルとの食い違い。** 計画ファイルは今も git でブランチに乗り、カードだけが DB にある。
  同期を入れると両方が同じブランチに乗り、ワークツリーでも計画とカードが揃う

### Migration Plan

1. マイグレーション v5 で `sync_state` を作る（既存の DB に行は入らない）
2. メインで `ai-board sync` を実行する。base が無く DB にだけカードがあるので、全カードがファイルに書き出される
3. 書き出したファイルをコミットする

ロールバックは、`sync` を使わなければ従来どおり DB だけで動く。`sync_state` は残っても害が無い。

## タスク

- [ ] マイグレーション v5（`sync_state`: `key TEXT PRIMARY KEY` / `hash TEXT NOT NULL`、キーは `card:<id>` と `divider`）とテスト
- [ ] `SyncStateRepository` と SQLite 実装
- [ ] `CardFileStore`: `.ai-board/cards/` の一覧・読み込み・書き込み、`idea-divider.yaml` の読み書き
  - [ ] 不正なファイルは警告して読み飛ばす（既存の `parseCard` の方針に揃える）
- [ ] `syncCards` usecase: 判定表の全行、`--prefer`、衝突の報告、区切り線
  - [ ] 判定表の各行をテストにする
- [ ] エラー種（`SyncConflict` など）と、CLI での表示
- [ ] `ai-board sync` サブコマンドと、`ai-board import` の削除
- [ ] 空の DB の自動取り込み（`cli-main.ts` のサブコマンドと `server.ts` の起動時）とテスト
- [ ] `card-markdown.ts` の docstring、`config.ts` のパスと説明
- [ ] README / CLAUDE.md: 同期の流れ、書き込み境界の表、エージェントのハードルール
- [ ] メインの DB を `sync` で書き出し、`.ai-board/cards/` をコミットする
- [ ] 品質ゲート（`npm run typecheck && npm run lint && npm test`）
