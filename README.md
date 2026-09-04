# ai-board

OpenSpec 駆動開発のためのローカル Web カンバン。

`openspec/` ディレクトリと GitLab を読んで各カードのステージを自動導出し、
実態から導出できない部分（アイデア・探索・実装中）だけをカードファイルに保存する。

```
アイデア → 探索済み → 提案済み → 実装中 → AI-PR → AI-PR 修正済み → 完了
```

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

同梱のデモで動作を確認できる。

```bash
node dist/cli.js --root examples/demo
```

## ステージの決まり方

`card.stageOverride`（手動上書き）があればそれを最優先。無ければ以下を
**上から評価し、最初に真になったもの**を採用する（＝最も進んだステージ）。

| #   | stage         | 条件                                                                                    |
| --- | ------------- | --------------------------------------------------------------------------------------- |
| 1   | `done`        | archive に `YYYY-MM-DD-<change>` が存在、**または** MR が merged                        |
| 2   | `ai-pr-fixed` | MR が opened、レビューコメントが 1 件以上、かつ **最新コミット > 最新レビューコメント** |
| 3   | `ai-pr`       | MR が存在し opened                                                                      |
| 4   | `impling`     | `implStartedAt` が非 null                                                               |
| 5   | `proposed`    | `openspec/changes/<change>/proposal.md` が存在                                          |
| 6   | `explored`    | `explored` が true                                                                      |
| 7   | `idea`        | 既定                                                                                    |

### 誰が動かせるか

人が手で動かせるのは、**カードファイルのフラグで実際に決まる列だけ**。
残りは openspec と GitLab の実態から決まるため、AI の領分としてドラッグを受け付けない。

| 列                        | ステージを立てるもの   | 誰の領分か                    |
| ------------------------- | ---------------------- | ----------------------------- |
| アイデア / 探索済み       | `explored` フラグ      | 人                            |
| 実装中                    | `implStartedAt` の打刻 | 人（AI に着手を指示する合図） |
| 提案済み 🔒               | `proposal.md` の存在   | AI                            |
| AI-PR / AI-PR 修正済み 🔒 | GitLab の MR 状態      | AI                            |
| 完了 🔒                   | archive / merged       | AI                            |

ドラッグは `stageOverride` ではなく **実フラグを書き換える**（アイデアへ落とせば
`explored: false`、実装中へ落とせば `implStartedAt` を打刻）。実態を伴わない
見かけ上の移動が起きないようにするため。

さらに、**動かせる先はカードごとに違う**。フラグを両方外したときに残るステージ
（AI の成果物が課す下限）より前へは戻せない。

| 下限                             | 手で入れられる列                                          |
| -------------------------------- | --------------------------------------------------------- |
| `idea`                           | アイデア / 探索済み / 実装中                              |
| `proposed`                       | 実装中のみ（AI が提案を書いたので、アイデアには戻せない） |
| `ai-pr` / `ai-pr-fixed` / `done` | なし（カードを掴めない）                                  |

`stageOverride` は読み取り専用の逃げ道として残る。ファイルに手で書けば
その列に出て乖離バッジが付くが、API では設定を拒否し、解除（`null`）だけを受け付ける。

### その他の設計上の判断

- **`impling` は明示マーカーでのみ立つ。** 「AI が実装作業中」はファイルから観測できない。
  tasks.md の進捗からは導出しない — 実装 → コミット → MR を一気に進める流れでこの列が消滅するため。
  tasks の完了数はカード上のプログレスバーとしてのみ表示する。
- **`ai-pr-fixed` は「AI が指摘を受けて修正を push した」＝再レビュー待ち。**
  GitLab の `resolved` フラグはレビュアーの操作なので使わない。
  新しいレビューコメントが来れば日時比較が逆転し、自然に `ai-pr` へ戻る。
- **手動上書きは隠さない。** 自動導出と食い違うカードには「⚠ 実態は …」バッジを出す。

## カードファイル

`.ai-board/cards/<id>.md` の 1 ファイルが 1 カード。
`id` は不変で、`change` / `branch` / `mr` が進行に応じて後から埋まる。
これによりアイデアメモ → change → ブランチ → MR → archive が 1 本の線でつながる。

```markdown
---
id: refresh-token # 不変。生成後は変えない
title: リフレッシュトークン対応
created: 2026-09-01T09:00:00.000Z
explored: true # explored へ昇格させる明示フラグ
implStartedAt: null # impling へ昇格させる明示マーカー
change: refresh-token # openspec の change 名
branch: feat/refresh-token
mr: 42 # GitLab MR iid（branch から自動解決して書き戻す）
stageOverride: null # 手動上書き。null なら自動導出
---

## アイデア

## 探索メモ
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
`ai-pr` 系の列が空になるだけでボードは動く。GitLab がダウンしても
ボードは落ちず、直近のキャッシュを保ったまま「GitLab 未接続」を表示する。

MR 一覧の全件取得はページングで取りこぼすため使わず、カード単位で問い合わせる。

## 設計

`openspec` CLI をサブプロセス起動せず、ディレクトリを直接読む。

- `openspec list --json` は archive を除外するため完了列を作れない
- change ごとに `openspec status` を呼ぶと N プロセス起動になる
- 完了判定はファイル存在のみで、構造が単純かつ安定している
- openspec 未インストールの環境でも動く

判定ロジックは `@fission-ai/openspec` v1.3.1 の実装に合わせてある
（tasks のカウント正規表現、archive の日付プレフィックス、artifact の存在判定）。

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
| `GET`    | `/api/events`         | SSE。ファイル変更・ポーリング結果を push             |

`PATCH` では `undefined`（未指定＝変更しない）と `null`（値を消す）を区別する。

`stageOverride` は `null`（解除）しか受け付けない。値を指定すると 400 を返す
— ステージは実態から導出するものであり、ツール自身が実態と食い違う値を書かないため。

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
