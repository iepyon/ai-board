# ai-board

OpenSpec 駆動開発のためのローカル Web カンバン。

`openspec/` ディレクトリと GitLab を読んで各カードのステージを自動導出する。
`stage` という値はどこにも保存しない。人の判断（着手・承認・否決・中止）も
カードファイル上の痕跡として残り、それも導出の入力になる。

```
[ アイデア ] [ 探索中 ] [ 探索レビュー ] [ 計画提案中 ] [ 計画レビュー ] [ 実装中 ] [ 検証中 ] [ PR中 ] [ マージ済み ]
     人          AI          人 ★           AI            人 ★          AI        AI      人 ★        —
```

★ が人の判断を待つゲート。人がドラッグで動かすのは `アイデア ⇄ 探索中` の 1 遷移だけで、
あとは AI が右へ進め、★ で止まる。

## なぜ必要か

OpenSpec で spec 駆動開発を回すとき、作業の実態は3つの場所に散らばる。

| 情報               | 所在                        |
| ------------------ | --------------------------- |
| アイデア・調査メモ | **どこにもない**            |
| change の進捗      | `openspec/changes/<id>/`    |
| MR / レビュー状態  | GitLab                      |
| 完了               | `openspec/changes/archive/` |

`openspec view` は specs と changes しか見せないため、アイデアから完了までを
一本のパイプラインとして俯瞰する手段がない。ai-board はその欠けたビューを埋める。

## 使い方

```bash
npm install
npm run build

# openspec/ を持つプロジェクトのルートで起動する
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

| #   | stage            | 条件                                                                       |
| --- | ---------------- | -------------------------------------------------------------------------- |
| 1   | `merged`         | archive に `YYYY-MM-DD-<change>` が存在、**または** MR が merged            |
| 2   | `pr`             | MR が存在し opened                                                          |
| 3   | `verifying`      | plan ゲート通過済み、かつ tasks が 1 件以上あってすべて完了、MR はまだ無い  |
| 4   | `impling`        | plan ゲート通過済み                                                         |
| 5   | `plan-review`    | `openspec/changes/<change>/proposal.md` が存在し、plan ゲートが未判断        |
| 6   | `planning`       | explore ゲート通過済み                                                      |
| 7   | `explore-review` | 本文に `## 探索メモ` があり、explore ゲートが未判断                         |
| 8   | `exploring`      | `startedAt` が非 null                                                       |
| 9   | `idea`           | 既定                                                                        |

**否決の差し戻しに専用のルールは無い。** ゲートが「差し戻し中」のとき
その工程のレビュー行と承認行が両方外れ、1 つ手前の AI 列へ自然に落ちる。

### レビューログ

人の判断はカード本文の `## レビュー` に追記される。ゲートは `explore` と `plan`、
種別は 提出 / 再提出（AI が書く）と 承認 / 否決 / 中止（人が書く）の 5 つ。

```markdown
## レビュー

### 2026-09-11T04:00:00.000Z explore 提出

### 2026-09-11T05:12:00.000Z explore 否決

既存の stage-resolver を見ていない。導出ルールとの整合を調べ直して。

### 2026-09-11T09:30:00.000Z explore 再提出
```

ゲートの状態は、そのゲートの最新エントリ 1 件で決まる。書式の壊れた見出しは黙って無視する
（カードは人が直接編集してよいファイルなので、手書きの揺れでボードが読めなくなるほうが害が大きい）。

中止のエントリはゲートの判定から除く。中止は工程の進捗とは直交する終端の軸であり、
通過済みのゲートを巻き戻さない。

`pr` ゲートだけレビューログを持たない。MR の承認とマージは GitLab 側の実態そのもので、
カード本文に写す必要が無いため。

### スキップ

frontmatter の `skipGates` に書いたゲートは、ログを見ずに通過扱いになる。
小さいカードを夜間に `/loop` で流したいときに使う。カードはそのレビュー列に一瞬も滞留しない。

### 誰が動かせるか

| 列                        | ステージを立てるもの          | 誰の領分か |
| ------------------------- | ----------------------------- | ---------- |
| アイデア / 探索中         | `startedAt` の打刻            | 人         |
| 探索レビュー              | 本文の `## 探索メモ`          | AI が書く  |
| 計画提案中                | `## レビュー` の explore 承認 | 人         |
| 計画レビュー              | `proposal.md` の存在          | AI         |
| 実装中 / 検証中           | `## レビュー` の plan 承認 と tasks の進捗 | 人 → AI |
| PR中                      | GitLab の MR 状態             | AI         |
| マージ済み                | archive / merged              | AI         |

**人がドラッグで動かせるのは `アイデア ⇄ 探索中` の 1 遷移だけ。**
承認 / 否決 / 中止 は詳細パネルのボタンから行い、`## レビュー` への追記になる。
否決には理由文が必須（空の否決は AI が次の周回で読むものを持たない）。

さらに、**動かせる先はカードごとに違う**。`startedAt` を外したときに残るステージ
（AI の成果物と人のレビュー記録が課す下限）より前へは戻せない。

| 下限                        | 手で入れられる列       |
| --------------------------- | ---------------------- |
| `idea`                      | アイデア / 探索中      |
| `explore-review` 以降       | なし（カードを掴めない） |

### その他の設計上の判断

- **`verifying` は tasks の全完了で立つ。** タスクを全部倒したのに MR がまだ無い状態＝
  品質ゲートを回している最中。`total === 0` は全完了扱いにしない（tasks.md が
  まだ書かれていないだけの change を検証中へ飛ばしてしまうため）。
- **レビュー後の修正は `pr` 列内のバッジ。** 「AI が指摘を受けて修正を push した」を
  最新コミットと最新レビューコメントの時刻比較で判定し、再提出済みとして示す。
  GitLab の `resolved` フラグはレビュアーの操作なので使わない。
  新しいレビューコメントが来れば日時比較が逆転し、自然にバッジが消える。
- **否決からの復帰は AI の「再提出」追記で表す。** ファイルの mtime 比較は成立しない
  （レビュー記録を書く行為そのもので mtime が動くため）。
- **中止に専用の列は作らない。** マージ済みとは意味が違うので混ぜない。
  既定でボードから畳み、トップバーのトグルで掘り起こせる。

## カードファイル

`.ai-board/cards/<id>.md` の 1 ファイルが 1 カード。
`id` は不変で、`change` / `branch` / `mr` が進行に応じて後から埋まる。
これによりアイデアメモ → change → ブランチ → MR → archive が 1 本の線でつながる。

```markdown
---
id: refresh-token # 不変。生成後は変えない
title: リフレッシュトークン対応
created: 2026-09-01T09:00:00.000Z
startedAt: '2026-09-01T10:00:00.000Z' # 人が探索の着手を指示した時刻
skipGates: [] # 人が事前に見ないと宣言したゲート（explore / plan）
change: refresh-token # openspec の change 名
branch: feat/refresh-token
mr: 42 # GitLab MR iid（branch から自動解決して書き戻す）
---

## アイデア

## 探索メモ

## レビュー
```

エディタで直接書き換えると、ファイル監視を通じてブラウザへ即座に反映される。

**書き込みは `.ai-board/` 配下のみ。`openspec/` は read-only** に徹する
（openspec CLI と AI エージェントの領分を侵さない）。

## GitLab 連携

`.ai-board/config.yaml`:

```yaml
gitlab:
  url: http://localhost:8080
  projectId: 3 # 数値 id または "group/project"
```

トークンは環境変数からのみ読む。設定ファイルには書かない。

```bash
export AI_BOARD_GITLAB_TOKEN=glpat-xxxxxxxxxxxx
```

`gitlab` セクションかトークンのどちらかが欠けていれば連携は無効になり、
`PR中` / `マージ済み` の列が MR 由来の情報を失うだけでボードは動く。GitLab がダウンしても
ボードは落ちず、直近のキャッシュを保ったまま「GitLab 未接続」を表示する。

MR 一覧の全件取得はページングで取りこぼすため使わず、カード単位で問い合わせる。

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

アクセストークンの発行:

```bash
docker compose exec -T gitlab gitlab-rails runner "
u = User.find_by_username('root')
t = u.personal_access_tokens.build(scopes: ['api'], name: 'ai-board', expires_at: 365.days.from_now)
t.set_token('glpat-xxxxxxxxxxxxxxxxxxxx')
t.save!
"
```

動かない場合は Web UI（`/-/user_settings/personal_access_tokens`）から `api` スコープで発行する。
発行したトークンは `.env` に `AI_BOARD_GITLAB_TOKEN=` として置き、起動時に読み込む。

疎通確認:

```bash
set -a; . ./.env; set +a

# GitLab が生きているか。/-/health は monitoring_whitelist により
# コンテナ内からは 200、ホストからは 404 になるので疎通判定には使わない
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8929/users/sign_in      # 200

# トークンが有効か
curl -s -H "PRIVATE-TOKEN: $AI_BOARD_GITLAB_TOKEN" http://localhost:8929/api/v4/user

# ボードが接続できているか
curl -s localhost:5673/api/board | jq .gitlab                                      # {"status":"connected"}

# カードの mr.webUrl に実際に到達できるか。列が埋まっていることを疎通の根拠にしない
curl -s localhost:5673/api/board | jq -r '.cards[] | select(.mrState) | .mrState.webUrl'
```

GitLab を停止してもボードは落ちず、接続状態が `error` になって列は直近のキャッシュを保つ。

```bash
docker compose stop     # ボードは HTTP 200 のまま、gitlab は {"status":"error"}
docker compose start    # 復帰すると connected に戻る
docker compose down -v  # データごと破棄
```


## 設計

`openspec` CLI をサブプロセス起動せず、ディレクトリを直接読む。

- `openspec list --json` は archive を除外するため完了列を作れない
- change ごとに `openspec status` を呼ぶと N プロセス起動になる
- 完了判定はファイル存在のみで、構造が単純かつ安定している
- openspec 未インストールの環境でも動く

判定ロジックは `@fission-ai/openspec` v1.12.0 の実装に合わせてある
（tasks の行パターン、archive の日付プレフィックス、artifact の存在判定）。
openspec を上げたときは参照先の定数を突き合わせる。

ただし change 名自体が `YYYY-MM-DD-` で始まる場合、1.12.0 は接頭辞を重ねず
既存名のまま archive するため、日付を剥がす前提のこちらの完了判定が外れる。

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
    repositories/openspec.repository.ts
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
| `GET`    | `/api/board`          | 全カード＋導出ステージ＋openspec / GitLab 由来の情報 |
| `POST`   | `/api/cards`          | 新規アイデアカード作成                               |
| `PATCH`  | `/api/cards/:id`      | frontmatter の部分更新                               |
| `PUT`    | `/api/cards/:id/body` | 本文の差し替え                                       |
| `POST`   | `/api/cards/:id/reviews` | `## レビュー` へのエントリ追記                    |
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
