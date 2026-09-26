# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## このリポジトリは何か

計画ファイル駆動の開発のためのローカル Web カンバン。
カードのステージは計画ファイル・レビュー要求（GitHub の PR）・カードの実態から**導出**される。
`stage` という値はどこにも保存しない。人の判断（着手・承認・否決・中止）も
カード上の痕跡として残り、それも導出の入力になる。

```
[ アイデア ] [ 計画提案中 ] [ 計画レビュー ] [ 実装中 ] [ PR中 ] [ マージ済み ]
     人            AI            人 ★          AI       人 ★        —
```

★ が人の判断を待つ HIL ゲート。人がドラッグで動かすのは `アイデア ⇄ 計画提案中` の 1 遷移だけ。

スタックは TypeScript (ESM, Node >= 22.13。カードの保存に組み込みの `node:sqlite` を使う) / Express 5 + React 19 + Vite / Vitest。
サーバは `127.0.0.1:5673` にのみ bind するローカル専用ツールで、認証やレート制限は持たない。

## 品質ゲート

コミット前に必ず通す。

```bash
npm run typecheck && npm run lint && npm test
```

- `typecheck` は tsc を 2 回走らせる（`tsconfig.json` = サーバ、`tsconfig.web.json` = web）。
  片方だけ通っても不十分。
- テスト単体で走らせるとき: `npx vitest run src/board/services/__tests__/stage-resolver.test.ts`、
  名前で絞るなら `npx vitest run -t 'done'`。
- ビルドは `npm run build`（tsc → `dist/`、vite → `dist/web/`）。
- 開発時は `npm run dev`（サーバのみ、tsx watch）と `npm run dev:web`（Vite、`/api` を 5673 へプロキシ）。

## タスクは `.ai-board/board.db` にある

**このリポジトリ自身のバックログはボードのカードとして `.ai-board/board.db`（SQLite）に置かれている。**
何に着手するかを判断するときは、まずここを読む。1 行 = 1 カード。DB は git に載せない。

**読み書きは `ai-board card` の CLI で行う。DB を sqlite3 などで直接触らない。**
（開発中は `node dist/cli.js card ...`。先に `npm run build` が要る）

```bash
ai-board card list                 # 一覧（JSON、本文なし、rank 順）
ai-board card show <id>            # 1 枚を下の Markdown の形で
ai-board card body <id> < body.md  # 本文の差し替え（## レビュー のエントリは変えられない）
ai-board card branch <id> <name>   # ブランチの紐付け（--clear で外す）
ai-board card submit <id> [--resubmit] [--reason <text>]   # plan 提出 / 再提出
ai-board card create --title <t> [--id <id>] < body.md     # アイデアカードの起票
```

`card show` の出力（DB の列を frontmatter の形で表したもの）:

```yaml
---
id: board-search # 不変。生成後は変えない。ファイル名と一致する kebab-case
title: カードを絞り込めるようにする
created: '2026-09-04T06:48:23.416Z'
startedAt: null # 人が着手を指示した時刻（人が打つ）
skipGates: [] # 人が事前に見ないと宣言したゲート（plan）
branch: null
mr: null # レビュー要求の番号（branch から自動解決して書き戻す）
forge: null # その番号がどの取得先のものか（現在は github のみ）。mr と必ず対で書く
rank: 1500 # 並び順（任意）。小さいほど上。人が並べ替えたときだけ書かれる
---
```

本文の見出しにも意味がある。`## レビュー` は人の判断を残す追記専用ログで、
ステージ導出の入力になる。`## 探索メモ` は自由記述であり、導出には効かない。

`id` が不変で `branch` / `mr` が進行に応じて後から埋まることで、
アイデアメモ → 計画 → ブランチ → PR → archive が 1 本の線につながる。
計画は `.ai-board/plans/<id>.md` に同じ名前で置かれる。ID がファイル名を決めるので、
紐付けのためのフィールドは持たない。
CLI の書き込みはサーバが `PRAGMA data_version` の変化で拾い、SSE 経由でブラウザへ即座に反映される
（`src/infrastructure/database.ts` の `watchDatabase`）。サーバ自身の書き込みは
`data_version` に現れないので、リポジトリの `onWrite` から通知する。

移行前の `.ai-board/cards/<id>.md` は `ai-board import` で取り込む。
Markdown 表現（`card-markdown.ts`）はこの取り込みと `card show` の出力にだけ使う。

## 書き込み境界

「誰の書き込みか」で分かれる。混同しないこと。

| 主体            | `.ai-board/plans/`                           | カード（`.ai-board/board.db`）                 |
| --------------- | -------------------------------------------- | ---------------------------------------------- |
| ai-board サーバ | **read-only**                                | 書く（画面の操作・MR 番号の書き戻し）          |
| AI エージェント | 書く（計画・タスクの更新・archive への移動） | `ai-board card` 経由で本文・ブランチ・提出のみ |

エージェントが**やってはいけないこと**（`board-loop-skill` カードのハードルール）:

- `startedAt` を自分で打たない。これは人が着手を指示する合図。
- `## レビュー` に書いてよいのは 提出 / 再提出 だけ。承認 / 否決 / 中止 は人が書く。
- `skipGates` を自分で足さない。
- `rank` を書かない。並び順は人が決める優先度で、エージェントは上から読むだけ。
- 計画レビュー / PR中 のカードのステージに触らない。
- 品質ゲートを通らないままコミットしない。

このうちカードに関わるものは `ai-board card`（`src/cards/cli/card-cli.ts`）が構造で強制する。
CLI には `startedAt` / `rank` / `skipGates` を書く入口も、承認 / 否決 / 中止を追記する入口も無く、
`body` は `## レビュー` のエントリが変わる差し替えを拒否する。**CLI に入口を足すときはこの境界を崩さない。**

ステージを直接指定する入力口は存在しない。列を動かしたければ、その列を成立させる実態
（`startedAt` の打刻、計画ファイルの作成、`## レビュー` への承認追記）を作る。

## ステージ導出

核は `src/board/services/stage-resolver.ts` の純関数。
6 段の判定表と各ルールの理由はそのファイルの docstring にある（README にも同じ表がある）。
**変更するならまずここを読む。** ルールは制御構造ではなく `RULES` 配列の順序で表現され、
「上から評価して最初に真になったものが勝つ（＝最も進んだステージ）」を意味する。

ゲートの状態は `src/cards/services/review-log.ts` が本文の `## レビュー` から読む。
ゲートは `plan` の 1 つだけで、廃止した `explore` のエントリは規定外として黙って無視される。
`gateState()` はゲートごとの最新エントリ 1 件で決まり、中止のエントリは判定から除く
（中止は工程の進捗と直交する終端の軸で、通過済みのゲートを巻き戻さない）。

守るべきは列の所有権の分割。

| 列                    | ステージを立てるもの                     | 領分 |
| --------------------- | ---------------------------------------- | ---- |
| アイデア / 計画提案中 | `startedAt` の打刻                       | 人   |
| 計画レビュー          | `.ai-board/plans/<id>.md` の存在         | AI   |
| 実装中                | `## レビュー` の plan 承認               | 人   |
| PR中                  | PR が opened                             | AI   |
| マージ済み            | 計画が archive 済み、または PR が merged | AI   |

UI のドラッグは `startedAt` を書き換える 1 遷移だけ。承認 / 否決 / 中止はボタンで
`POST /api/cards/:id/reviews` を呼び、本文への追記になる。
「`startedAt` を外したときに残るステージ」（AI の成果物とレビュー記録が課す下限）より
前へは戻せない（`resolveFloorStage` / `droppableStages`）。

否決の差し戻しに専用ルールは無い。ゲートが差し戻し中のときレビュー行と承認行が両方外れ、
1 つ手前の AI 列へ自然に落ちる。**ここに `if` を足したくなったら設計を疑う。**

計画ファイルは `src/board/repositories/plan.repository.ts` が読む。
ファイル名がそのままカード ID なので、ID として不正な名前のファイルは警告して読み飛ばす
（ここで例外を投げるとボード全体が 500 になり、置き場所を間違えた 1 ファイルで画面が死ぬ）。

**計画ファイルが存在するだけで計画レビューの列が立つ。** エージェントが書き始めた時点で
列が動くが、本来のゲートは本文の `## レビュー` に書かれる `plan 提出` であり、
ファイルの存在は「ログの欠落で人待ちを取りこぼさない」ための保険である。
「空ファイルは無視する」といった条件を足さない。

## レイヤー構成と規約

```
src/
  app.ts                Express アプリケーションファクトリ
  server.ts / cli.ts    起動（cli.ts は引数解析とブラウザ起動）
  shared/               Result<T,E>・Branded Types・設定・ミドルウェア
  cards/                カードの CRUD コンテキスト
  board/                3ソース統合・ステージ導出コンテキスト
  infrastructure/       ファイル監視・SSE・GitHub ポーリング
  web/                  React + Vite のカンバン UI
```

各コンテキストは `models/ errors/ repositories/ usecases/ controllers/ composition.ts` を持つ。

- **usecase は例外を投げず `Result<T, E>` を返す**（`src/shared/result.ts`）。
- **エラーは discriminated union**（`{ type: 'CardNotFound', id }`）で表し、
  controller が `*-error-mappings.ts` の `switch` で HTTP ステータスへ変換する。
  エラー種を増やしたらマッピングの `switch` も網羅する（型が漏れを検出する）。
- **依存はコンテキストごとの `composition.ts`（Composition Root）で構成する。**
  usecase やリポジトリの中で `new` して依存を作らない。
- **ID は Branded Type**（`CardId` / `MergeRequestIid`）。
  生の string を渡さず `createCardId` などのファクトリを通す（`src/shared/schemas/common.ts`）。
- 入力検証は Zod スキーマ（`models/schemas/`）。`PATCH` では `undefined`（未指定＝変更しない）と
  `null`（値を消す）を区別する。

### 型とビルドの制約

- サーバは `module: NodeNext` なので**相対 import に `.js` 拡張子が必要**（`./card.js`）。
- web は `moduleResolution: Bundler`。`src/shared/` は両方の tsconfig に含まれるため、
  **どちらのモードでも通る書き方**にする（Node 専用 API を持ち込まない）。
- パスエイリアスは使わない。相対パスのみ。
- 両方で `strict` + `noUncheckedIndexedAccess`。配列アクセスは `undefined` を考慮する。

### ESLint がエラーにするもの

`complexity: 12` / `max-lines-per-function: 120` / `@typescript-eslint/consistent-type-imports`
（型は `import type`）/ `no-console`（`warn` と `error` のみ許可）。
テストファイルは `max-lines-per-function` と `no-explicit-any` が緩められている。

### テスト

- **`src/**/__tests__/**/*.test.ts` に置く。** この glob 外は vitest が黙って無視する。
- カバレッジ閾値は lines/functions/statements 80%、branches 75%（`npm run test:coverage`）。
- API は supertest で e2e を書く（`src/board/controllers/__tests__/board.e2e.test.ts`）。
- **`src/web/` は vitest の対象外。** `environment: node` で、include glob は `.ts` のみ（`.tsx` を拾わない）、
  カバレッジからも除外され、jsdom も testing-library も入っていない。
  UI の変更は typecheck と lint で担保する。

## レビュー要求の取得先

取得先は GitHub の Pull Request だけ（GitLab 連携は廃止した）。
`.ai-board/config.yaml` に `github:` を書いたときだけ有効になる。
欠けていれば連携は無効になり `PR中` / `マージ済み` の列が空になるだけでボードは動く。

**アクセストークンは扱わない。** 問い合わせは `gh api` の実行として行い、
認証はログイン済みの CLI に委ねる。トークンを設定ファイル・環境変数から読む経路は無い。
CLI の有無とログイン状態は起動時に 1 度だけ確かめ（`ForgeClient.checkAuth`）、
使えなければ理由付きで `disabled` にする。

CLI の実行は `src/infrastructure/cli-runner.ts` に閉じる。**shell を介さず引数は配列で渡す。**
カードの `branch` は人もエージェントも自由に書ける場所であり、文字列連結でコマンドを
組み立てるとカードを書ける者が任意のコマンドを実行できる。
stderr は本文を載せず `(HTTP 404)` の数字だけを取り出して 404 判定に使う。

GitHub の PR は `state` が `open` / `closed` の 2 値しかなく、**マージ済みも `closed`** で返る。
区別は `merged_at` の有無で付ける（`toLifecycleState`）。ここを取り違えるとカードが
`merged` へ進まない。レビューコメントは issue comment と review comment の 2 か所に
分かれるため、合算して「人が書いた最新のコメント」とする。
どちらの一覧も既定は古い順の 1 ページ目だけで、`issues/{n}/comments` は `sort` /
`direction` を受け付けない（受けるのはリポジトリ単位の `issues/comments` の方）。
並び順に頼らず `gh api --paginate` で全ページ引いて最大値を取る。
最新コミットは `pulls/{n}/commits` ではなく `head.sha` を直接引く（件数で取り逃がさない）。
自動生成のコメントを示すフラグは無く、`user.type === 'Bot'` で外す。

PR 一覧の全件取得はページングで取りこぼすため使わず、カード単位で問い合わせる。

カードの `mr` は `forge` と対で持ち、`forge` が現在の取得先と違えば番号を使わず
`branch` から解決し直す（`ForgePoller.fetchFor`）。`forge` が無い古いカードは `branch` を優先する。
GitLab 時代の `forge: gitlab` のカードは、DB のマイグレーション（v2）と `ai-board import` で
`mr` / `forge` を消して `branch` から解決し直させる。GitLab の MR !1 と GitHub の PR #1 は別物で、
番号をそのまま引くと**列は正しく埋まったままリンクだけが別の PR を指す**。

## API

| メソッド | パス                     | 用途                                                    |
| -------- | ------------------------ | ------------------------------------------------------- |
| `GET`    | `/api/board`             | 全カード＋導出ステージ＋計画の進捗 / レビュー要求の情報 |
| `GET`    | `/api/plans/:id`         | 計画の本文。ボードには載せず、詳細パネルが個別に引く    |
| `POST`   | `/api/cards`             | 新規アイデアカード作成                                  |
| `PATCH`  | `/api/cards/:id`         | frontmatter の部分更新                                  |
| `PUT`    | `/api/cards/:id/body`    | 本文の差し替え                                          |
| `POST`   | `/api/cards/:id/reviews` | `## レビュー` へのエントリ追記（承認 / 否決 / 中止）    |
| `POST`   | `/api/cards/:id/move`    | 直前・直後のカード（`after` / `before`）の間へ並べ替え  |
| `GET`    | `/api/events`            | SSE。ファイル変更・ポーリング結果を push                |

## 計画ファイル

計画は `.ai-board/plans/<card-id>.md` に置く。ファイル名がカード ID と一致することで
カードと紐付くので、frontmatter に紐付け用のフィールドは無い。

Plan モードで立てた計画をそのまま書き、タスクはチェックボックス（`- [ ]` / `- [x]`）で
並べる。カードのプログレスバーはこの行を数えている（インデントされたサブタスクも
親と同じように数える）。チェックボックスの無い計画でもステージは動く。

1 周の流れ:

1. 人が `startedAt` を打つ（＝計画提案中へ）
2. AI が Plan モードで計画を立て、`.ai-board/plans/<id>.md` に書き、
   `ai-board card submit <id>` でカード本文の `## レビュー` に `plan 提出` を追記する（＝計画レビューへ）
3. 人が計画を読み、詳細パネルのボタンで承認 / 否決する（＝実装中へ）
4. AI がタスクを倒し、AI レビューまで済ませてから PR を出す（＝PR中へ）
5. マージされたら計画を `.ai-board/plans/archive/<id>.md` へ移す（＝マージ済みへ）

成果物は日本語で書く。

## コミット

日本語の Conventional Commits。

```
feat: GitHub の PR からレビューコメントの件数を引く
chore: 未着手カードの startedAt を null に戻す
docs: GitHub 連携の change を起票する
```
