# ai-board

計画ファイル駆動の開発のためのローカル Web カンバン。

`.ai-board/plans/` とレビュー要求（GitLab / GitHub）を読んで各カードのステージを自動導出する。
`stage` という値はどこにも保存しない。人の判断（着手・承認・否決・中止）も
カード上の痕跡として残り、それも導出の入力になる。

```
[ アイデア ] [ 計画提案中 ] [ 計画レビュー ] [ 実装中 ] [ PR中 ] [ マージ済み ]
     人            AI            人 ★          AI      人 ★        —
```

★ が人の判断を待つゲート。人がドラッグで動かすのは `アイデア ⇄ 計画提案中` の 1 遷移だけで、
あとは AI が右へ進め、★ で止まる。

## なぜ必要か

AI エージェントと開発を回すとき、作業の実態は複数の場所に散らばる。

| 情報               | 所在                            |
| ------------------ | ------------------------------- |
| アイデア・調査メモ | `.ai-board/board.db`（SQLite）  |
| 計画とタスクの進捗 | `.ai-board/plans/<id>.md`       |
| MR / PR のレビュー | GitLab / GitHub                 |
| 完了               | `.ai-board/plans/archive/`      |

どれも見ようと思えば見られるが、アイデアから完了までを一本のパイプラインとして
俯瞰する手段がない。ai-board はその欠けたビューを埋める。

**そして「いま誰の番か」を可視化する。** 人が判断すべき 2 点（計画レビューと PR）で
列が止まり、それ以外は AI が右へ進める。

## 使い方

```bash
npm install
npm run build

# .ai-board/ を持つプロジェクトのルートで起動する
node dist/cli.js --root /path/to/your-project
```

```
使い方: ai-board [options]

  --root <path>          対象プロジェクトのルート (既定: カレントディレクトリ)
  --port <n>             待ち受けポート (既定: 5673、使用中なら自動で繰り上げ)
  --no-open              ブラウザを自動で開かない
  --poll-interval <ms>   GitLab のポーリング間隔 (既定: 30000)
  -h, --help             ヘルプを表示
```

サーバは `127.0.0.1` にのみ bind する。

## ステージの決まり方

以下を**上から評価し、最初に真になったもの**を採用する（＝最も進んだステージ）。
手動上書きの仕組みは無い。

| #   | stage         | 条件                                                                      |
| --- | ------------- | ------------------------------------------------------------------------- |
| 1   | `merged`      | 計画が `.ai-board/plans/archive/` にある、**または** MR が merged           |
| 2   | `pr`          | MR が存在し opened                                                         |
| 3   | `impling`     | plan ゲート通過済み                                                        |
| 4   | `plan-review` | `.ai-board/plans/<id>.md` が存在し、plan ゲートが未判断                     |
| 5   | `planning`    | `startedAt` が非 null                                                      |
| 6   | `idea`        | 既定                                                                       |

**否決の差し戻しに専用のルールは無い。** ゲートが「差し戻し中」のとき
その工程のレビュー行と承認行が両方外れ、1 つ手前の列へ自然に落ちる。

### レビューログ

人の判断はカード本文の `## レビュー` に追記される。ゲートは `plan` の 1 つ、
種別は 提出 / 再提出（AI が書く）と 承認 / 否決 / 中止（人が書く）の 5 つ。

```markdown
## レビュー

### 2026-09-11T04:00:00.000Z plan 提出

### 2026-09-11T05:12:00.000Z plan 否決

既存の stage-resolver を見ていない。導出ルールとの整合を調べ直して。

### 2026-09-11T09:30:00.000Z plan 再提出
```

ゲートの状態は、そのゲートの最新エントリ 1 件で決まる。書式の壊れた見出しは黙って無視する
（カードは人が直接編集してよいファイルなので、手書きの揺れでボードが読めなくなるほうが害が大きい）。

中止のエントリはゲートの判定から除く。中止は工程の進捗とは直交する終端の軸であり、
通過済みのゲートを巻き戻さない。

`pr` ゲートはレビューログを持たない。MR の承認とマージは GitLab 側の実態そのもので、
カード本文に写す必要が無いため。

かつては `explore` ゲートもあったが、探索レビューの列とともに廃止した。
既存のカードに残る `explore` のエントリは規定外のゲートとして黙って無視される。

### スキップ

frontmatter の `skipGates` に書いたゲートは、ログを見ずに通過扱いになる。
小さいカードを夜間に `/loop` で流したいときに使う。カードはそのレビュー列に一瞬も滞留しない。

### 誰が動かせるか

| 列                        | ステージを立てるもの          | 誰の領分か |
| ------------------------- | ----------------------------- | ---------- |
| アイデア / 計画提案中     | `startedAt` の打刻            | 人         |
| 計画レビュー              | `.ai-board/plans/<id>.md` の存在 | AI      |
| 実装中                    | `## レビュー` の plan 承認                 | 人         |
| PR中                      | MR / PR が opened             | AI         |
| マージ済み                | 計画の archive / MR の merged | AI         |

**人がドラッグで動かせるのは `アイデア ⇄ 計画提案中` の 1 遷移だけ。**
承認 / 否決 / 中止 は詳細パネルのボタンから行い、`## レビュー` への追記になる。
否決には理由文が必須（空の否決は AI が次の周回で読むものを持たない）。

さらに、**動かせる先はカードごとに違う**。`startedAt` を外したときに残るステージ
（AI の成果物と人のレビュー記録が課す下限）より前へは戻せない。

| 下限                        | 手で入れられる列          |
| --------------------------- | ------------------------- |
| `idea`                      | アイデア / 計画提案中     |
| `plan-review` 以降          | なし（カードを掴めない）  |

### その他の設計上の判断

- **AI レビューに専用の列は作らない。** 実装中の内部工程として扱う。tasks の進捗は
  カード上のプログレスバーに出るだけで、ステージを立てる入力には使わない。
- **レビュー後の修正は `pr` 列内のバッジ。** 「AI が指摘を受けて修正を push した」を
  最新コミットと最新レビューコメントの時刻比較で判定し、再提出済みとして示す。
  GitLab の `resolved` フラグはレビュアーの操作なので使わない。
  新しいレビューコメントが来れば日時比較が逆転し、自然にバッジが消える。
- **否決からの復帰は AI の「再提出」追記で表す。** ファイルの mtime 比較は成立しない
  （レビュー記録を書く行為そのもので mtime が動くため）。
- **中止に専用の列は作らない。** マージ済みとは意味が違うので混ぜない。
  既定でボードから畳み、トップバーのトグルで掘り起こせる。

## カード

カードの正本は `.ai-board/board.db`（SQLite）の `cards` テーブルにあり、1 行が 1 カード。
DB は git に載せず、各自のローカルに置く。
`id` は不変で、`branch` / `mr` が進行に応じて後から埋まる。
これによりアイデアメモ → 計画 → ブランチ → MR → archive が 1 本の線でつながる。

`ai-board card show <id>` は、カードを次の Markdown の形で出す。

```markdown
---
id: refresh-token # 不変。生成後は変えない
title: リフレッシュトークン対応
created: 2026-09-01T09:00:00.000Z
startedAt: '2026-09-01T10:00:00.000Z' # 人が着手を指示した時刻
skipGates: [] # 人が事前に見ないと宣言したゲート（plan）
branch: feat/refresh-token
mr: 42 # GitLab MR iid（branch から自動解決して書き戻す）
rank: 1500 # 並び順。小さいほど上。並べ替えたときだけ書かれる
---

## アイデア

## レビュー
```

### カードを書く経路

人は画面から、エージェントは `ai-board card` の CLI から書く。
CLI は DB を直接開くのでサーバが止まっていても書け、サーバが動いていれば
`PRAGMA data_version` の変化を拾って SSE でブラウザへ即座に反映される。

```bash
ai-board card list                         # 一覧（JSON、本文なし、rank 順）
ai-board card show <id>                    # 1 枚を Markdown で
ai-board card create --title <t> [--id <id>] < body.md
ai-board card body <id> < body.md          # 本文の差し替え
ai-board card branch <id> <name>           # ブランチの紐付け（--clear で外す）
ai-board card submit <id> [--resubmit] [--reason <text>]   # plan 提出 / 再提出
```

CLI にはエージェントに許す操作しか無い。`startedAt`・`rank`・`skipGates` の書き換えと、
承認 / 否決 / 中止の追記は画面（HTTP API）からだけ行える。
`body` は `## レビュー` のエントリが変わる差し替えを拒否するので、本文の差し替えで
人の判断を書き換えることもできない。

移行前の `.ai-board/cards/<id>.md` は `ai-board import` で取り込める
（`--from <dir>` で取り込み元を変えられる）。既に DB にある ID は上書きしない。

### 並び順

列の中のカードはドラッグで並べ替えられ、上にあるものほど優先度が高い。
並び順は全カードで 1 本で、各列はそれを自分のカードだけに絞って見せる。
ステージが進んで列を移っても、優先度はそのまま持ち越される。

並べ替えると、動かしたカードの `rank` だけが書き換わる。`rank` の無いカードは
`created` のエポックミリ秒を `rank` とみなすので、並べ替えたことの無いカードは作成順に並び、
新しいカードは列の末尾に付く。`rank` を決めるのは人で、エージェントは読むだけにする。

## 計画ファイル

`.ai-board/plans/<card-id>.md` の 1 ファイルがそのカードの計画。
**ファイル名がカード ID と一致することで紐付く**ので、カードの frontmatter に
紐付け用のフィールドは無い。

```markdown
# リフレッシュトークン対応

## 方針

...

## タスク

- [x] トークンの保存先を決める
- [ ] 更新エンドポイントを足す
```

チェックボックス（`- [ ]` / `- [x]`）はカード上のプログレスバーになる。
インデントされたサブタスクも親と同じように数える（列 0 に固定すると
`  - [ ] 1.1.1 …` が進捗から消えるため）。**タスクの進捗はステージを立てない。**

マージされたら `.ai-board/plans/archive/<card-id>.md` へ移す。これがマージ済みの実態になる。

計画を書くのは AI エージェントで、**ai-board サーバは read-only** に徹する。
本文は `GET /api/plans/:id` で個別に取りに行き、`GET /api/board` には載せない
（計画はカード本文より桁違いに大きく、ファイル変更のたびに引き直されるため）。

**計画ファイルが存在するだけで計画レビューの列が立つ。** エージェントが書き始めた時点で
列が動くが、本来のゲートは本文の `## レビュー` に書かれる `plan 提出` であり、
ファイルの存在は「ログの欠落で人待ちを取りこぼさない」ための保険である。

## レビュー要求の取得先

`PR中` / `マージ済み` の列は、カードに紐付いたレビュー要求
（GitLab の Merge Request、GitHub の Pull Request）の状態で決まる。
取得先は GitLab か GitHub の **どちらか一方** を選ぶ。

`.ai-board/config.example.yaml` をコピーして書き換える。
`config.yaml` は各自の接続先なので git の追跡外にしてある。

```bash
cp .ai-board/config.example.yaml .ai-board/config.yaml
```

```yaml
# GitLab を使う場合
gitlab:
  url: http://localhost:8929 # compose.yaml の external_url と一致させること
  projectId: 3 # 数値 id または "group/project"
```

```yaml
# GitHub を使う場合
github:
  repository: iepyon/ai-board # owner/repo
```

両方書かれていると起動を中止する。どちらが効いているか分からないまま動かさないため。

### アクセストークンは要らない

ai-board はトークンを受け取らない。問い合わせは `glab api` / `gh api` の実行として行い、
**認証はログイン済みの CLI に委ねる。**

```bash
glab auth login   # GitLab を使う場合
gh auth login     # GitHub を使う場合
```

CLI が入っていない、または未ログインなら連携は無効になり、理由が画面に出る。
設定そのものが無い場合も同じく無効になり、`PR中` / `マージ済み` の列が
レビュー要求由来の情報を失うだけでボードは動く。取得先がダウンしてもボードは落ちず、
直近のキャッシュを保ったまま接続状態だけを error にする。

CLI の有無とログイン状態は起動時に 1 度だけ確かめる。ログインし直したら ai-board を再起動する。

GitLab のホストは `config.yaml` の `url` から決まり、`GITLAB_HOST` として glab へ渡す。
複数インスタンスにログインしているとき、glab の既定ホストを引いて
別インスタンスの MR を静かに取得するのを防ぐため。

レビュー要求の一覧の全件取得はページングで取りこぼすため使わず、カード単位で問い合わせる。
問い合わせるのは `branch` か `mr` が書かれたカードだけ。

### 取得先を切り替えるとき

識別番号は取得先ごとに独立している。GitLab の MR !1 と GitHub の PR #1 は別物だが、
どちらも存在するので番号だけでは区別が付かず、そのまま引くと**列は正しく埋まったまま
リンクだけが別のレビュー要求を指す**。画面上は何も壊れて見えない。

そのためカードは番号を取得先と対で持つ。

```yaml
branch: setup-local-gitlab
mr: 1
forge: gitlab # この番号は GitLab のもの、という記録
```

`forge` が現在の取得先と違うカードは、番号を使わず `branch` から解決し直し、
得られた番号と取得先を書き戻す。`branch` が無ければそのカードにレビュー要求は
無いものとして扱う。`forge` が書かれていない古いカードは `branch` を優先する。

切り替えのために手で何かを消す必要は無い。

GitHub はレビューコメントが 2 か所（PR 全体への返信とコード行への指摘）に分かれるため、
両方を合算して GitLab の「system でないノート」と意味を揃えている。

### ローカル GitLab

検証用の GitLab を Docker Compose で立てられる。`compose.yaml` が起動するのは
GitLab だけで、ai-board 本体は従来どおり npm で動かす。

```bash
cp .env.example .env       # GITLAB_ROOT_PASSWORD を書く（8 文字以上）
docker compose up -d       # 初回はイメージ取得と初期化で数分かかる
docker compose ps          # healthy になるまで待つ
```

| 項目 | 値 |
| ---- | -- |
| URL | http://localhost:8929 |
| 管理ユーザー | `root` / `.env` の `GITLAB_ROOT_PASSWORD` |
| SSH | `ssh://git@localhost:2222/<namespace>/<project>.git` |
| 常駐メモリ | 約 2.4 GiB（実測。prometheus・registry を落とし puma を single mode にした状態） |

**ポートに 8080 は使えない。** omnibus の puma が内部で `127.0.0.1:8080` に bind するため
nginx と衝突し、puma だけが `EADDRINUSE` で無限に再起動する。このときコンテナは落ちないので
`RestartCount` は 0、Docker の health も `starting` に張り付いたまま、外からは 502 が返り続ける。
コンテナ層のシグナルは何も異常を示さないので、`gitlab-ctl status` で puma の pid 経過時間が
毎回リセットされていないかを見る。8929 はこの衝突を避けるために GitLab 公式が例示するポート。

`external_url` は必ず実際にブラウザで開く URL と一致させる。GitLab はこの値を API の
`web_url` に載せ、ai-board はそれをそのままカードのリンクにする。ずれていても API は 200 を
返すため、**列は埋まったままリンクだけが静かに壊れる**。

glab のログイン:

```bash
glab auth login --hostname localhost:8929
```

Web UI（`/-/user_settings/personal_access_tokens`）から `api` スコープのトークンを
発行して glab に食わせる。ai-board 自身はトークンを受け取らず、以降は glab の
ログイン状態だけを使う。

疎通確認:

```bash
# GitLab が生きているか。/-/health は monitoring_whitelist により
# コンテナ内からは 200、ホストからは 404 になるので疎通判定には使わない
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8929/users/sign_in      # 200

# glab がログイン済みか
GITLAB_HOST=localhost:8929 glab auth status

# glab から API を叩けるか
GITLAB_HOST=localhost:8929 glab api user

# ボードが接続できているか
curl -s localhost:5673/api/board | jq .forge     # {"status":"connected","kind":"gitlab"}

# カードの mr.webUrl に実際に到達できるか。列が埋まっていることを疎通の根拠にしない
curl -s localhost:5673/api/board | jq -r '.cards[] | select(.mrState) | .mrState.webUrl'
```

#### アップグレード

イメージのタグは `compose.yaml` に直接書いてある。
上げるときはこの行を書き換えてコミットする。
リポジトリの記述と実際に動いているものが常に一致し、`git log` がそのままアップグレードの履歴になる。

稼働中のバージョンはコンテナの中を見る。

```bash
docker compose exec -T gitlab head -1 /opt/gitlab/version-manifest.txt   # gitlab-ce 19.3.2
```

`docker image inspect` のラベルは当てにならない。
`org.opencontainers.image.version` が返すのはベースイメージの Ubuntu のバージョン（`24.04`）で、
GitLab のバージョンではない。

**required stop を飛ばすわけにはいかない。**
GitLab は特定のバージョンを踏まないとマイグレーションが完走しない作りになっていて、
しかもイメージを戻すだけのダウングレードができない（古いバージョンは移行済みの DB で起動しない）。
失敗したときに戻る先はバックアップだけになる。
上げる前に
[upgrade_paths.md](https://gitlab.com/gitlab-org/gitlab/-/blob/master/doc/update/upgrade_paths.md)
で現在のバージョンから次の stop を確認し、間の stop を順に踏む。

バックアップを取る。
捨ててよい検証用データなら飛ばしてよいが、MR とカードの紐付けを残したいなら取っておく。

```bash
mkdir -p gitlab-backup                                  # .gitignore 済み
docker compose exec -T gitlab gitlab-backup create

# gitlab-secrets.json はバックアップに含まれない。これを失うと DB 内の
# 暗号化データ（アクセストークン、CI 変数）が復号できなくなるので別に退避する。
docker compose cp gitlab:/etc/gitlab/gitlab-secrets.json ./gitlab-backup/

# tar を取り出す。ファイル名は作成時刻を含むので一覧から拾う。
docker compose exec -T gitlab sh -c 'ls -t /var/opt/gitlab/backups/*_gitlab_backup.tar | head -1'
docker compose cp gitlab:/var/opt/gitlab/backups/<上で出たファイル名> ./gitlab-backup/
```

タグを書き換えてから入れ替える。

```bash
docker compose pull
docker compose up -d
docker compose logs -f gitlab   # reconfigure と db:migrate を見届ける
docker compose ps               # healthy に戻るまで待つ（数分かかる）
```

`up -d` はコンテナを作り直すだけで、`gitlab-config` / `gitlab-logs` / `gitlab-data` の
3 つの named volume には触らない。
設定もログもリポジトリも残り、消えるのは `down -v` を打ったときだけ。

healthy に戻ったら、上の疎通確認をもう一度通す。
とくにカードの `mr.webUrl` に実際に到達できるかまで見る。
マイグレーションが通ってボードの列が埋まっていても、`external_url` の扱いが変われば
リンクだけが静かに壊れる。

GitLab を停止してもボードは落ちず、接続状態が `error` になって列は直近のキャッシュを保つ。

```bash
docker compose stop     # ボードは HTTP 200 のまま、gitlab は {"status":"error"}
docker compose start    # 復帰すると connected に戻る
docker compose down -v  # データごと破棄
```


## 設計

**ステージはどこにも保存しない。** 3 つの実態（カード・計画ファイル・レビュー要求）
から純関数で導出する。列を動かしたければ、その列を成立させる実態を作る。
手動で上書きする入力口は無い。

計画ファイルはディレクトリを直接読む。ファイル名がそのままカード ID なので、
ID として不正な名前のファイルは警告して読み飛ばす（ここで例外を投げるとボード全体が
500 になり、置き場所を間違えた 1 ファイルで画面が死ぬ）。

かつては OpenSpec の `openspec/changes/` を読んでいたが、Plan モードで立てた計画を
そのまま成果物にするほうが工程が短いため、計画ファイル 1 本に寄せた。
移行前の change は `.ai-board/plans/archive/` に計画として残してある。

### レイヤー構成

```
src/
  app.ts                Express アプリケーションファクトリ
  server.ts / cli.ts    起動
  shared/               Result<T,E>・Branded Types・設定・ミドルウェア
  cards/                カードの CRUD コンテキスト
    models/ errors/ repositories/ usecases/ controllers/ composition.ts
  board/                3ソース統合・ステージ導出コンテキスト
    services/stage-resolver.ts    ← 核となる純関数
    repositories/plan.repository.ts
    services/gitlab-client.ts
  infrastructure/       ファイル監視・SSE・GitLab ポーリング
  web/                  React + Vite のカンバン UI
```

- usecase はすべて `Result<T, E>` を返し、例外を投げない
- エラーは discriminated union（`{ type: 'CardNotFound' }`）で表し、
  controller が `*-error-mappings.ts` で HTTP ステータスへ変換する
- 依存はコンテキストごとの `composition.ts`（Composition Root）で構成する

### API

| メソッド | パス                  | 用途                                                 |
| -------- | --------------------- | ---------------------------------------------------- |
| `GET`    | `/api/board`          | 全カード＋導出ステージ＋計画の進捗 / レビュー要求の情報 |
| `GET`    | `/api/plans/:id`      | 計画の本文。ボードには載せず詳細パネルが個別に引く   |
| `POST`   | `/api/cards`          | 新規アイデアカード作成                               |
| `PATCH`  | `/api/cards/:id`      | frontmatter の部分更新                               |
| `PUT`    | `/api/cards/:id/body` | 本文の差し替え                                       |
| `POST`   | `/api/cards/:id/reviews` | `## レビュー` へのエントリ追記                    |
| `POST`   | `/api/cards/:id/move` | 直前・直後のカード（`after` / `before`）の間へ並べ替え |
| `GET`    | `/api/events`         | SSE。ファイル変更・ポーリング結果を push             |

`PATCH` では `undefined`（未指定＝変更しない）と `null`（値を消す）を区別する。

ステージを直接指定する入力口は無い。`POST /api/cards/:id/reviews` はゲート・種別・理由文を
受け取って本文へ追記するだけで、列は次の `GET /api/board` で導出し直される。
否決に理由文が無ければ 400 を返す。

## 開発

```bash
npm test              # vitest（unit + supertest による API e2e）
npm run test:coverage # カバレッジ（閾値 80%）
npm run lint
npm run typecheck
npm run build
npm run dev           # サーバのみ（tsx watch）
npm run dev:web       # Vite dev サーバ（/api を 5673 へプロキシ）
```

## ライセンス

MIT License. 詳細は [LICENSE](LICENSE) を参照。
